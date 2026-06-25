// Security regression: MIME injection → same-origin XSS via inline attachment serving.
//
// Attack: upload a file with HTML/JS content, declare Content-Type: text/html in the
// multipart part. Pre-fix, the server stores text/html verbatim and serves the download
// with Content-Type: text/html + Content-Disposition: inline → browser inline-executes
// the HTML on the same origin → XSS, steals localStorage JWT.
//
// Fix contract:
//   - sanitizeMimeType() normalises client-declared MIME before storage (strips params,
//     lowercase, rejects malformed types).
//   - safeDownloadHeaders() enforces a safe-inline whitelist: XSS-risky types (text/html,
//     text/javascript, image/svg+xml, application/xhtml+xml …) become
//     Content-Type: application/octet-stream + Content-Disposition: attachment.
//   - Safe image types (jpeg/png/gif/webp) remain inline.
//
// These tests will FAIL before the fix (the exported functions do not exist yet),
// and PASS after.
//
// Run: npx tsx --test --test-force-exit test/mimeXssGuard.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeMimeType } from "../src/server/attachments.ts";
import { safeDownloadHeaders } from "../src/server/routes-api/attachments.ts";

// ── sanitizeMimeType ────────────────────────────────────────────────────────

test("sanitizeMimeType: strips params from declared MIME type", () => {
  assert.equal(sanitizeMimeType("text/plain; charset=utf-8"), "text/plain");
  assert.equal(sanitizeMimeType("image/jpeg; name=photo.jpg"), "image/jpeg");
});

test("sanitizeMimeType: normalises to lowercase", () => {
  assert.equal(sanitizeMimeType("TEXT/HTML"), "text/html");
  assert.equal(sanitizeMimeType("Image/PNG"), "image/png");
});

test("sanitizeMimeType: keeps well-formed types unchanged", () => {
  assert.equal(sanitizeMimeType("application/octet-stream"), "application/octet-stream");
  assert.equal(sanitizeMimeType("application/pdf"), "application/pdf");
});

test("sanitizeMimeType: falls back to octet-stream for empty input", () => {
  assert.equal(sanitizeMimeType(""), "application/octet-stream");
});

test("sanitizeMimeType: falls back to octet-stream for malformed / injection input", () => {
  assert.equal(sanitizeMimeType("not-a-mime"), "application/octet-stream");
  assert.equal(sanitizeMimeType("inject\r\nX-Header: bad"), "application/octet-stream");
  assert.equal(sanitizeMimeType("/nosubtype"), "application/octet-stream");
});

// ── safeDownloadHeaders: XSS-risky types → attachment + octet-stream ───────

test("safeDownloadHeaders: text/html → attachment + octet-stream (core XSS prevention)", () => {
  const h = safeDownloadHeaders("text/html", "evil.html");
  assert.equal(h["content-type"], "application/octet-stream",
    "must NOT reflect text/html back to browser");
  assert.match(h["content-disposition"], /^attachment;/,
    "must force attachment so browser never inline-renders it");
});

test("safeDownloadHeaders: text/javascript → attachment", () => {
  const h = safeDownloadHeaders("text/javascript", "evil.js");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: application/javascript → attachment", () => {
  const h = safeDownloadHeaders("application/javascript", "evil.js");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: application/xhtml+xml → attachment", () => {
  const h = safeDownloadHeaders("application/xhtml+xml", "evil.xhtml");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: image/svg+xml → attachment (SVG can contain inline scripts)", () => {
  const h = safeDownloadHeaders("image/svg+xml", "evil.svg");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: text/xml → attachment", () => {
  const h = safeDownloadHeaders("text/xml", "data.xml");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: application/xml → attachment", () => {
  const h = safeDownloadHeaders("application/xml", "data.xml");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: unknown/exotic type → attachment", () => {
  const h = safeDownloadHeaders("application/x-executable", "malware.exe");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

test("safeDownloadHeaders: empty/falsy MIME → attachment + octet-stream", () => {
  const h = safeDownloadHeaders("", "file.dat");
  assert.equal(h["content-type"], "application/octet-stream");
  assert.match(h["content-disposition"], /^attachment;/);
});

// ── safeDownloadHeaders: safe image/media types remain inline ───────────────

test("safeDownloadHeaders: image/jpeg → inline (safe for display)", () => {
  const h = safeDownloadHeaders("image/jpeg", "photo.jpg");
  assert.equal(h["content-type"], "image/jpeg");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/png → inline", () => {
  const h = safeDownloadHeaders("image/png", "img.png");
  assert.equal(h["content-type"], "image/png");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/gif → inline", () => {
  const h = safeDownloadHeaders("image/gif", "anim.gif");
  assert.equal(h["content-type"], "image/gif");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/webp → inline", () => {
  const h = safeDownloadHeaders("image/webp", "img.webp");
  assert.equal(h["content-type"], "image/webp");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: image/avif → inline", () => {
  const h = safeDownloadHeaders("image/avif", "img.avif");
  assert.equal(h["content-type"], "image/avif");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: application/pdf → inline", () => {
  const h = safeDownloadHeaders("application/pdf", "doc.pdf");
  assert.equal(h["content-type"], "application/pdf");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: video/mp4 → inline", () => {
  const h = safeDownloadHeaders("video/mp4", "clip.mp4");
  assert.equal(h["content-type"], "video/mp4");
  assert.match(h["content-disposition"], /^inline;/);
});

test("safeDownloadHeaders: audio/mpeg → inline", () => {
  const h = safeDownloadHeaders("audio/mpeg", "track.mp3");
  assert.equal(h["content-type"], "audio/mpeg");
  assert.match(h["content-disposition"], /^inline;/);
});

// ── filename encoding preserved ─────────────────────────────────────────────

test("safeDownloadHeaders: filename is RFC 5987 encoded in content-disposition", () => {
  const h = safeDownloadHeaders("image/jpeg", "héllo wörld.jpg");
  assert.match(h["content-disposition"], /filename\*=UTF-8''h%C3%A9llo%20w%C3%B6rld\.jpg/);
});

// ── nosniff header always present ───────────────────────────────────────────

test("safeDownloadHeaders: x-content-type-options: nosniff on safe inline type", () => {
  const h = safeDownloadHeaders("image/jpeg", "photo.jpg");
  assert.equal(h["x-content-type-options"], "nosniff",
    "nosniff must prevent browser from sniffing a declared image/jpeg as text/html");
});

test("safeDownloadHeaders: x-content-type-options: nosniff on forced attachment type", () => {
  const h = safeDownloadHeaders("text/html", "evil.html");
  assert.equal(h["x-content-type-options"], "nosniff");
});
