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

function buildImages(objects) {
  const images = {};

 objects.sort((a, b) =>
  a.uploaded.getTime() - b.uploaded.getTime() ||
  a.key.localeCompare(b.key)
);
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

        // Replace one selected gallery image
const indexParam = url.searchParams.get("index");

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
  ).sort((a, b) =>
    a.uploaded.getTime() - b.uploaded.getTime() ||
    a.key.localeCompare(b.key)
  );

  const oldImage = gallery[index];

  if (!oldImage) {
    return json({error: "Gallery image not found"}, 404);
  }

  const newKey =
    `media/g/${slot}/${crypto.randomUUID()}.${ext}`;

  await bucket.put(newKey, file.stream(), {
    httpMetadata: {contentType: file.type}
  });

  await bucket.delete(oldImage.key);

  return json({
    success: true,
    url: publicUrl(newKey)
  });
}

        const group = request.method === "POST"
          ? "g" : isVideo ? "v" : "s";

        const key = `media/${group}/${slot}/${crypto.randomUUID()}.${ext}`;

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
  .sort((a, b) =>
    a.uploaded.getTime() - b.uploaded.getTime() ||
    a.key.localeCompare(b.key)
  );

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
