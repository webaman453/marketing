import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic auth gate: signed-out visitors never see the app shell flash.
 * The API still verifies every request; this only checks a session cookie exists.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("ash_rt") || request.cookies.has("ash_at");
  if (!hasSession) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app", "/w/:path*", "/admin"],
};
