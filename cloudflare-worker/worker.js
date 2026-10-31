const PUBLIC_URL =
  "https://pub-ce63f017c2bb4a7e8168a54119308bf5.r2.dev";

const ORIGINS = [
  "https://king-of-cards.github.io"
  // "http://localhost:5500",
  // "http://127.0.0.1:5500"
];

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 50 * 1024 * 1024;

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function validSlot(slot) {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(slot || "");
}

function publicUrl(key) {
  return PUBLIC_URL + "/" +
    key.split("/").map(encodeURIComponent).join("/");
}

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN;
  const actual = request.headers.get("Authorization");
  return Boolean(expected && actual === `Bearer ${expected}`);
}

// List every object under a prefix (handles pagination)
async function listAll(bucket, prefix = "media/") {
  const objects = [];
  let cursor;

  do {
    const result = await bucket.list({
      prefix,
      cursor,
      limit: 1000
    });
    objects.push(...result.objects);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return objects;
}

// Objects for a slot's single media (image "s" or video "v")
async function listSingles(bucket, slot) {
  const [images, videos] = await Promise.all([
    listAll(bucket, `media/s/${slot}/`),
    listAll(bucket, `media/v/${slot}/`)
  ]);
  return [...images, ...videos];
}

// Delete keys in batches (R2 allows up to 1000 per call)
async function deleteKeys(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

// Stable gallery order. Keys made by this worker start with a 13-digit
// timestamp; older keys fall back to their upload time.
function orderOf(o) {
  const m = o.key.split("/").pop().match(/^(\d{13})-/);
  return m ? Number(m[1]) : o.uploaded.getTime();
}
const byOrder = (a, b) =>
  orderOf(a) - orderOf(b) || a.key.localeCompare(b.key);

const CONTENT_KEY = "content/site.json";
const MAX_CONTENT = 200 * 1024;

// Only plain JSON data with sane sizes is accepted
function validContent(v, depth = 0) {
  if (depth > 8) return false;
  if (typeof v === "string") return v.length <= 5000;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return true;
  if (Array.isArray(v)) {
    return v.length <= 200 && v.every(x => validContent(x, depth + 1));
  }
  if (typeof v === "object") {
    const entries = Object.entries(v);
    return entries.length <= 100 && entries.every(
      ([k, x]) => k.length <= 100 && validContent(x, depth + 1)
    );
  }
  return false;
}

function buildImages(objects) {
  const images = {};

  objects.sort(byOrder);

  for (const object of objects) {
    const parts = object.key.split("/");
    if (parts.length !== 4) continue;

    const [, type, slot] = parts;
    const url = publicUrl(object.key);

    if (type === "g") {
      if (!Array.isArray(images[slot])) images[slot] = [];
      images[slot].push(url);
    } else if (type === "s" || type === "v") {
      images[slot] = url;
    }
  }

  return images;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = {};

    if (ORIGINS.includes(origin)) {
      cors["Access-Control-Allow-Origin"] = origin;
      cors["Vary"] = "Origin";
    }

    cors["Access-Control-Allow-Methods"] =
      "GET, POST, PUT, DELETE, OPTIONS";
    cors["Access-Control-Allow-Headers"] =
      "Authorization, Content-Type";
    cors["Access-Control-Max-Age"] = "86400";
    cors["Cache-Control"] = "no-store"; // always return the latest list

    const json = (data, status = 200) =>
      response(data, status, cors);

    if (request.method === "OPTIONS") {
      if (!ORIGINS.includes(origin)) {
        return json({error: "Origin not allowed"}, 403);
      }
      return new Response(null, {status: 204, headers: cors});
    }

    try {
      // Friendly root route (no bucket needed)
      if (url.pathname === "/") {
        return json({
          status: "ok",
          service: "king-of-cards-image-api"
        });
      }

      if (!env.IMAGES_BUCKET) {
        return json({error: "R2 binding missing"}, 500);
      }

      const bucket = env.IMAGES_BUCKET;

      if (url.pathname === "/health") {
        try {
          // Real connectivity test: touch the bucket
          await bucket.list({limit: 1});
          return json({status: "OK", bucketConnected: true});
        } catch (err) {
          console.error(err);
          return json({
            status: "ERROR",
            bucketConnected: false
          }, 503);
        }
      }

      if (url.pathname === "/api/admin-check") {
        return authorized(request, env)
          ? json({authenticated: true})
          : json({error: "Unauthorized"}, 401);
      }

      // ---- Editable page content (text) stored as one JSON file ----
      if (url.pathname === "/api/content") {
        if (request.method === "GET") {
          const obj = await bucket.get(CONTENT_KEY);
          if (!obj) return json({content: null});
          let content = null;
          try { content = JSON.parse(await obj.text()); } catch (e) {}
          return json({content, updated: obj.uploaded.toISOString()});
        }

        if (request.method === "PUT") {
          if (!authorized(request, env)) {
            return json({error: "Unauthorized"}, 401);
          }

          const text = await request.text();
          if (text.length > MAX_CONTENT) {
            return json({error: "Content too large"}, 413);
          }

          let data;
          try { data = JSON.parse(text); }
          catch (e) { return json({error: "Invalid JSON"}, 400); }

          const ok = data && typeof data === "object" &&
            !Array.isArray(data) &&
            data.home && typeof data.home === "object" &&
            Array.isArray(data.photo) && Array.isArray(data.gift) &&
            Array.isArray(data.how) && Array.isArray(data.ghow) &&
            Array.isArray(data.occ) &&
            data.photo.every(v => v && typeof v.id === "string") &&
            data.gift.every(v => v && typeof v.id === "string") &&
            validContent(data);

          if (!ok) return json({error: "Invalid content"}, 400);

          const body = JSON.stringify(data);
          const opts = {httpMetadata: {contentType: "application/json"}};

          await bucket.put(CONTENT_KEY, body, opts);
          await bucket.put(`content/versions/${Date.now()}.json`, body, opts);

          // keep only the 10 newest saved versions
          const versions = await listAll(bucket, "content/versions/");
          versions.sort((a, b) => b.key.localeCompare(a.key));
          await deleteKeys(bucket, versions.slice(10).map(o => o.key));

          return json({success: true});
        }

        return json({error: "Method not allowed"}, 405);
      }

      if (url.pathname !== "/api/images") {
        return json({error: "Not found"}, 404);
      }

      if (request.method === "GET") {
        const objects = await listAll(bucket);
        return json({images: buildImages(objects)});
      }

      if (!authorized(request, env)) {
        return json({error: "Unauthorized"}, 401);
      }

      const slot = url.searchParams.get("slot");

      if (!validSlot(slot)) {
        return json({error: "Invalid image slot"}, 400);
      }

      if (request.method === "PUT" ||
          request.method === "POST") {

        const form = await request.formData();
        const file = form.get("file");

        if (!(file instanceof File)) {
          return json({error: "File required"}, 400);
        }

        const types = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif",
          "video/mp4": "mp4",
          "video/webm": "webm"
        };

        const ext = types[file.type];

        if (!ext) {
          return json({error: "Unsupported file type"}, 400);
        }

        const isVideo = file.type.startsWith("video/");
        const maxSize = isVideo ? MAX_VIDEO : MAX_IMAGE;

        if (file.size > maxSize || file.size === 0) {
          return json({error: "Invalid file size"}, 400);
        }

        if (request.method === "POST" && isVideo) {
          return json({error: "Gallery requires images"}, 400);
        }

        // Basic file signature validation
        const bytes = new Uint8Array(
          await file.slice(0, 16).arrayBuffer()
        );

        const ascii = String.fromCharCode(...bytes);
        const signatures = {
          "image/jpeg": bytes[0] === 255 &&
            bytes[1] === 216 && bytes[2] === 255,
          "image/png": ascii.startsWith("\x89PNG"),
          "image/gif": ascii.startsWith("GIF8"),
          "image/webp": ascii.startsWith("RIFF") &&
            ascii.slice(8, 12) === "WEBP",
          "video/mp4": ascii.slice(4, 8) === "ftyp",
          "video/webm": bytes[0] === 26 &&
            bytes[1] === 69 && bytes[2] === 223 &&
            bytes[3] === 163
        };

        if (!signatures[file.type]) {
          return json({error: "File content invalid"}, 400);
        }

        const indexParam = url.searchParams.get("index");

        // Replace one gallery image in place (keeps its position)
        if (request.method === "PUT" && indexParam !== null) {
          const index = Number(indexParam);

          if (!Number.isSafeInteger(index) || index < 0) {
            return json({error: "Invalid gallery index"}, 400);
          }

          if (isVideo) {
            return json({error: "Gallery requires images"}, 400);
          }

          const gallery = (
            await listAll(bucket, `media/g/${slot}/`)
          ).sort(byOrder);

          const oldImage = gallery[index];

          if (!oldImage) {
            return json({error: "Gallery image not found"}, 404);
          }

          // New file inherits the old file's position
          const newKey =
            `media/g/${slot}/${orderOf(oldImage)}-${crypto.randomUUID()}.${ext}`;

          await bucket.put(newKey, file.stream(), {
            httpMetadata: {contentType: file.type}
          });
          await bucket.delete(oldImage.key);

          return json({success: true, url: publicUrl(newKey)});
        }

        const group = request.method === "POST"
          ? "g" : isVideo ? "v" : "s";

        // Gallery keys carry a timestamp so their order is stable
        const stamp = group === "g" ? `${Date.now()}-` : "";
        const key =
          `media/${group}/${slot}/${stamp}${crypto.randomUUID()}.${ext}`;

        await bucket.put(key, file.stream(), {
          httpMetadata: {contentType: file.type}
        });

        // Replace old single-slot media (scoped to this slot only)
        if (request.method === "PUT") {
          const singles = await listSingles(bucket, slot);
          const oldKeys = singles
            .filter(o => o.key !== key)
            .map(o => o.key);

          await deleteKeys(bucket, oldKeys);
        }

        return json({success: true, url: publicUrl(key)});
      }

      if (request.method === "DELETE") {
        const indexParam = url.searchParams.get("index");

        if (indexParam !== null) {
          const index = Number(indexParam);

          if (!Number.isSafeInteger(index) || index < 0) {
            return json({error: "Invalid index"}, 400);
          }

          const gallery = (await listAll(bucket, `media/g/${slot}/`))
            .sort(byOrder);

          if (!gallery[index]) {
            return json({error: "Image not found"}, 404);
          }

          await bucket.delete(gallery[index].key);
        } else {
          const singles = await listSingles(bucket, slot);
          await deleteKeys(bucket, singles.map(o => o.key));
        }

        return json({success: true});
      }

      return json({error: "Method not allowed"}, 405);

    } catch (error) {
      console.error(error);
      return json({error: "Server error"}, 500);
    }
  }
};
