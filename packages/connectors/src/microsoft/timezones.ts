/**
 * Microsoft Advertising TimeZone values ↔ IANA zones.
 * Values: https://learn.microsoft.com/advertising/guides/time-zones
 *
 * AccountRef.timezone is IANA (types.ts), so listAdAccounts turns Microsoft's value into an
 * IANA zone and createCampaign turns it back.
 */

/** Microsoft TimeZone value → the IANA zone it stands for. */
export const MS_TO_IANA: Record<string, string> = {
  AbuDhabiMuscat: "Asia/Dubai",
  Adelaide: "Australia/Adelaide",
  Alaska: "America/Anchorage",
  AlmatyNovosibirsk: "Asia/Almaty",
  AmsterdamBerlinBernRomeStockholmVienna: "Europe/Berlin",
  Arizona: "America/Phoenix",
  AstanaDhaka: "Asia/Dhaka",
  AthensBuckarestIstanbul: "Europe/Athens",
  AtlanticTimeCanada: "America/Halifax",
  AucklandWellington: "Pacific/Auckland",
  Azores: "Atlantic/Azores",
  Baghdad: "Asia/Baghdad",
  BakuTbilisiYerevan: "Asia/Baku",
  BangkokHanoiJakarta: "Asia/Bangkok",
  BeijingChongqingHongKongUrumqi: "Asia/Shanghai",
  BelgradeBratislavaBudapestLjubljanaPrague: "Europe/Budapest",
  BogotaLimaQuito: "America/Bogota",
  Brasilia: "America/Sao_Paulo",
  Brisbane: "Australia/Brisbane",
  BrusselsCopenhagenMadridParis: "Europe/Paris",
  Bucharest: "Europe/Bucharest",
  BuenosAiresGeorgetown: "America/Argentina/Buenos_Aires",
  Cairo: "Africa/Cairo",
  CanberraMelbourneSydney: "Australia/Sydney",
  CapeVerdeIsland: "Atlantic/Cape_Verde",
  CaracasLaPaz: "America/Caracas",
  CasablancaMonrovia: "Africa/Casablanca",
  CentralAmerica: "America/Guatemala",
  CentralTimeUSCanada: "America/Chicago",
  ChennaiKolkataMumbaiNewDelhi: "Asia/Kolkata",
  ChihuahuaLaPazMazatlan: "America/Mazatlan",
  Darwin: "Australia/Darwin",
  EasternTimeUSCanada: "America/New_York",
  Ekaterinburg: "Asia/Yekaterinburg",
  FijiKamchatkaMarshallIsland: "Pacific/Fiji",
  Greenland: "America/Nuuk",
  GreenwichMeanTimeDublinEdinburghLisbonLondon: "Europe/London",
  GuadalajaraMexicoCityMonterrey: "America/Mexico_City",
  GuamPortMoresby: "Pacific/Guam",
  HararePretoria: "Africa/Johannesburg",
  Hawaii: "Pacific/Honolulu",
  HelsinkiKyivRigaSofiaTallinnVilnius: "Europe/Helsinki",
  Hobart: "Australia/Hobart",
  IndianaEast: "America/Indiana/Indianapolis",
  InternationalDateLineWest: "Etc/GMT+12",
  IrkutskUlaanBataar: "Asia/Irkutsk",
  IslandamabadKarachiTashkent: "Asia/Karachi",
  Jerusalem: "Asia/Jerusalem",
  Kabul: "Asia/Kabul",
  Kathmandu: "Asia/Kathmandu",
  Krasnoyarsk: "Asia/Krasnoyarsk",
  KualaLumpurSingapore: "Asia/Singapore",
  KuwaitRiyadh: "Asia/Riyadh",
  MidAtlantic: "Atlantic/South_Georgia",
  MidwayIslandAndSamoa: "Pacific/Pago_Pago",
  MoscowStPetersburgVolgograd: "Europe/Moscow",
  MountainTimeUSCanada: "America/Denver",
  Nairobi: "Africa/Nairobi",
  Newfoundland: "America/St_Johns",
  "Newfoundland and Labrador": "America/St_Johns",
  Nukualofa: "Pacific/Tongatapu",
  OsakaSapporoTokyo: "Asia/Tokyo",
  PacificTimeUSCanadaTijuana: "America/Los_Angeles",
  Perth: "Australia/Perth",
  Santiago: "America/Santiago",
  SarajevoSkopjeWarsawZagreb: "Europe/Warsaw",
  Saskatchewan: "America/Regina",
  Seoul: "Asia/Seoul",
  SolomonIslandNewCaledonia: "Pacific/Guadalcanal",
  SriJayawardenepura: "Asia/Colombo",
  Taipei: "Asia/Taipei",
  Tehran: "Asia/Tehran",
  Vladivostok: "Asia/Vladivostok",
  WestCentralAfrica: "Africa/Lagos",
  Yakutsk: "Asia/Yakutsk",
  Yangon: "Asia/Yangon",
};

/**
 * IANA zone → Microsoft TimeZone value (the reverse table plus common aliases). Newfoundland is
 * left out: the docs spell it "Newfoundland and Labrador", which is not a safe enum value to send.
 */
const IANA_TO_MS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MS_TO_IANA).filter(([ms]) => !ms.startsWith("Newfoundland")).map(([ms, iana]) => [iana, ms])),
  "Asia/Calcutta": "ChennaiKolkataMumbaiNewDelhi",
  "Asia/Muscat": "AbuDhabiMuscat",
  "Europe/Amsterdam": "AmsterdamBerlinBernRomeStockholmVienna",
  "Europe/Rome": "AmsterdamBerlinBernRomeStockholmVienna",
  "Europe/Stockholm": "AmsterdamBerlinBernRomeStockholmVienna",
  "Europe/Vienna": "AmsterdamBerlinBernRomeStockholmVienna",
  "Europe/Zurich": "AmsterdamBerlinBernRomeStockholmVienna",
  "Europe/Istanbul": "AthensBuckarestIstanbul",
  "Asia/Hong_Kong": "BeijingChongqingHongKongUrumqi",
  "Asia/Jakarta": "BangkokHanoiJakarta",
  "Asia/Ho_Chi_Minh": "BangkokHanoiJakarta",
  "Europe/Prague": "BelgradeBratislavaBudapestLjubljanaPrague",
  "Europe/Belgrade": "BelgradeBratislavaBudapestLjubljanaPrague",
  "America/Lima": "BogotaLimaQuito",
  "Europe/Madrid": "BrusselsCopenhagenMadridParis",
  "Europe/Brussels": "BrusselsCopenhagenMadridParis",
  "Europe/Copenhagen": "BrusselsCopenhagenMadridParis",
  "Australia/Melbourne": "CanberraMelbourneSydney",
  "Europe/Dublin": "GreenwichMeanTimeDublinEdinburghLisbonLondon",
  "Europe/Lisbon": "GreenwichMeanTimeDublinEdinburghLisbonLondon",
  "America/Godthab": "Greenland",
  "Europe/Kiev": "HelsinkiKyivRigaSofiaTallinnVilnius",
  "Europe/Kyiv": "HelsinkiKyivRigaSofiaTallinnVilnius",
  "Asia/Kuala_Lumpur": "KualaLumpurSingapore",
  "Asia/Kuwait": "KuwaitRiyadh",
  "Asia/Katmandu": "Kathmandu",
  "Asia/Rangoon": "Yangon",
  "Asia/Saigon": "BangkokHanoiJakarta",
  "America/Tijuana": "PacificTimeUSCanadaTijuana",
  "US/Pacific": "PacificTimeUSCanadaTijuana",
  "US/Eastern": "EasternTimeUSCanada",
  "US/Central": "CentralTimeUSCanada",
  "US/Mountain": "MountainTimeUSCanada",
  "America/Toronto": "EasternTimeUSCanada",
  "America/Vancouver": "PacificTimeUSCanadaTijuana",
  "Europe/London": "GreenwichMeanTimeDublinEdinburghLisbonLondon",
  "Asia/Tokyo": "OsakaSapporoTokyo",
  "Asia/Karachi": "IslandamabadKarachiTashkent",
  "Asia/Tashkent": "IslandamabadKarachiTashkent",
};

/** An account's IANA zone as Microsoft's TimeZone value; a Microsoft value (older synced rows) passes through. */
export function microsoftTimeZone(zone: string | null | undefined, fallback = "EasternTimeUSCanada") {
  if (!zone) return fallback;
  if (IANA_TO_MS[zone]) return IANA_TO_MS[zone]!;
  if (MS_TO_IANA[zone]) return zone;
  return fallback;
}

/** Microsoft's TimeZone value as an IANA zone (null when it is not a known value). */
export function ianaTimeZone(msZone: string | null | undefined) {
  return msZone ? MS_TO_IANA[msZone] ?? null : null;
}
