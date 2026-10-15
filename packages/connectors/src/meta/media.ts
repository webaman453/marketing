/**
 * Reads an ad's creative from Meta and resolves it to files we can play and
 * download. Meta stores creatives in several shapes (single image, single
 * video, carousel, dynamic asset feed), so each is normalised to the same
 * AdMedia list. Media URLs are short-lived: callers fetch them fresh.
 */
import type { AdMedia, AdMediaItem } from "../types";
import type { MetaApi } from "./builder";

type Rec = Record<string, any>;

interface RawItem {
  videoId?: string;
  imageUrl?: string | null;
  imageHash?: string | null;
  title?: string | null;
  description?: string | null;
  link?: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function collect(c: Rec): RawItem[] {
  const oss: Rec = c.object_story_spec ?? {};
  const vd: Rec | undefined = oss.video_data;
  const ld: Rec | undefined = oss.link_data;
  const pd: Rec | undefined = oss.photo_data;
  const feed: Rec | undefined = c.asset_feed_spec;

  const cards: Rec[] = ld?.child_attachments ?? [];
  if (cards.length) {
    return cards.map((a) => ({
      videoId: str(a.video_id) ?? undefined,
      imageUrl: str(a.picture),
      imageHash: str(a.image_hash),
      title: str(a.name),
      description: str(a.description),
      link: str(a.link),
    }));
  }
  if (vd?.video_id) {
    return [{ videoId: String(vd.video_id), imageUrl: str(vd.image_url), title: str(vd.title), description: str(vd.link_description), link: str(vd.call_to_action?.value?.link) }];
  }
  if (feed && (feed.videos?.length || feed.images?.length)) {
    return [
      ...(feed.videos ?? []).map((v: Rec): RawItem => ({ videoId: str(v.video_id) ?? undefined, imageUrl: str(v.thumbnail_url) })),
      ...(feed.images ?? []).map((i: Rec): RawItem => ({ imageHash: str(i.hash), imageUrl: str(i.url) })),
    ];
  }
  if (ld && (ld.picture || ld.image_hash)) {
    return [{ imageUrl: str(ld.picture), imageHash: str(ld.image_hash), title: str(ld.name), description: str(ld.description), link: str(ld.link) }];
  }
  if (pd && (pd.url || pd.image_hash)) return [{ imageUrl: str(pd.url), imageHash: str(pd.image_hash) }];
  if (c.video_id) return [{ videoId: String(c.video_id), imageUrl: str(c.thumbnail_url) }];
  if (c.image_url || c.image_hash) return [{ imageUrl: str(c.image_url), imageHash: str(c.image_hash) }];
  if (c.thumbnail_url) return [{ imageUrl: str(c.thumbnail_url) }];
  return [];
}

export async function metaFetchAdMedia(api: MetaApi, accountId: string, adId: string): Promise<AdMedia> {
  const ad = await api.get<Rec>(`/${adId}`, {
    fields:
      "creative{title,body,call_to_action_type,image_url,image_hash,video_id,thumbnail_url,object_story_spec,asset_feed_spec}",
  });
  const c: Rec = ad.creative ?? {};
  const oss: Rec = c.object_story_spec ?? {};
  const vd: Rec | undefined = oss.video_data;
  const ld: Rec | undefined = oss.link_data;

  const raws = collect(c);

  // Image hashes only carry a small thumbnail; the account's image library has the full file.
  const hashes = [...new Set(raws.flatMap((r) => (r.imageHash && !r.videoId ? [r.imageHash] : [])))];
  const full = new Map<string, string>();
  if (hashes.length) {
    try {
      const res = await api.get<{ data: { hash: string; url?: string }[] }>(`/act_${accountId}/adimages`, {
        hashes: JSON.stringify(hashes),
        fields: "hash,url",
      });
      for (const i of res.data ?? []) if (i.url) full.set(i.hash, i.url);
    } catch {
      // fall back to the picture URL on the creative
    }
  }

  const items = await Promise.all(
    raws.map(async (r): Promise<AdMediaItem> => {
      if (r.videoId) {
        let source: string | null = null;
        let poster = r.imageUrl ?? null;
        let length: number | null = null;
        let permalink: string | null = null;
        try {
          const v = await api.get<Rec>(`/${r.videoId}`, { fields: "source,picture,length,permalink_url" });
          source = str(v.source);
          poster = str(v.picture) ?? poster;
          length = typeof v.length === "number" ? Math.round(v.length) : null;
          permalink = str(v.permalink_url) ? `https://www.facebook.com${v.permalink_url}` : null;
        } catch {
          // The video may belong to a Page we cannot read; the poster still shows.
        }
        return { type: "VIDEO", url: source, posterUrl: poster, title: r.title ?? null, description: r.description ?? null, link: r.link ?? null, durationSec: length, permalink };
      }
      const url = (r.imageHash && full.get(r.imageHash)) || r.imageUrl || null;
      return { type: "IMAGE", url, posterUrl: r.imageUrl ?? url, title: r.title ?? null, description: r.description ?? null, link: r.link ?? null, durationSec: null, permalink: null };
    }),
  );

  const format: AdMedia["format"] =
    items.length === 0 ? "UNKNOWN" : items.length > 1 ? "CAROUSEL" : items[0]!.type === "VIDEO" ? "VIDEO" : "IMAGE";

  return {
    format,
    headline: str(c.title) ?? str(vd?.title) ?? str(ld?.name),
    body: str(c.body) ?? str(vd?.message) ?? str(ld?.message),
    callToAction: str(c.call_to_action_type) ?? str(vd?.call_to_action?.type) ?? str(ld?.call_to_action?.type),
    link: str(ld?.link) ?? str(vd?.call_to_action?.value?.link),
    items,
  };
}
