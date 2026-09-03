import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import app from "../src/app.js";
import {
  deleteUserSignature,
  getUserSignature,
  isValidPngFile,
  SIGNATURE_BUCKET,
  signatureStoragePath,
  uploadUserSignature,
} from "../src/services/signature.service.js";
import { composeTicketReplyHtml } from "../src/services/ticket-reply.service.js";
import { parseMultipart } from "../src/middlewares/multipart.middleware.js";

const USER_ID = "3aa8a815-efb3-4972-bf52-6156e046cd95";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

class FakeSupabase {
  constructor() {
    this.user = {
      signature_enabled: false,
      signature_storage_path: null,
      data_atualizacao: "2026-09-02T12:00:00.000Z",
    };
    this.uploads = [];
    this.removals = [];
    this.storage = {
      from: (bucket) => {
        assert.equal(bucket, SIGNATURE_BUCKET);
        return {
          upload: async (path, buffer, options) => {
            this.uploads.push({ path, buffer, options });
            return { error: null };
          },
          remove: async (paths) => {
            this.removals.push(paths);
            return { error: null };
          },
          getPublicUrl: (path) => ({
            data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/${SIGNATURE_BUCKET}/${path}` },
          }),
        };
      },
    };
  }

  from(table) {
    assert.equal(table, "users");
    return new FakeQuery(this);
  }
}

class FakeQuery {
  constructor(database) {
    this.database = database;
    this.operation = "select";
    this.values = null;
  }

  select() {
    this.operation = "select";
    return this;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  eq() {
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.execute());
  }

  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }

  execute() {
    if (this.operation === "update") {
      Object.assign(this.database.user, this.values);
    }
    return { data: this.database.user, error: null };
  }
}

let server;
let baseUrl;

before(async () => {
  process.env.JWT_SECRET =
    "teste-jwt-secret-super-seguro-com-mais-de-32-caracteres-123456";
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("endpoints de assinatura exigem autenticação", async () => {
  const requests = [
    ["GET", "/api/profile/signature"],
    ["POST", "/api/profile/signature"],
    ["PUT", "/api/profile/signature/settings"],
    ["DELETE", "/api/profile/signature"],
  ];

  for (const [method, path] of requests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
      body: method === "PUT" ? JSON.stringify({ enabled: true }) : undefined,
    });
    assert.equal(response.status, 401);
  }
});

test("multipart FormData chega em req.file no campo signature", async () => {
  const formData = new FormData();
  formData.append("signature", new Blob([PNG], { type: "image/png" }), "signature.png");
  const request = new Request("http://localhost/upload", { method: "POST", body: formData });
  const req = Readable.from([Buffer.from(await request.arrayBuffer())]);
  req.headers = { "content-type": request.headers.get("content-type") };

  await new Promise((resolve, reject) => {
    parseMultipart(
      req,
      { status: () => ({ json: reject }) },
      () => resolve(),
    );
    req.on("error", reject);
  });

  assert.equal(req.file.fieldname, "signature");
  assert.equal(req.file.originalname, "signature.png");
  assert.equal(req.file.mimetype, "image/png");
  assert.deepEqual(req.file.buffer, PNG);
});
test("validação aceita PNG real e rejeita MIME ou magic bytes falsos", () => {
  const valid = { originalname: "signature.png", mimetype: "image/png", buffer: PNG };
  assert.equal(isValidPngFile(valid), true);
  assert.equal(isValidPngFile({ ...valid, mimetype: "image/svg+xml" }), false);
  assert.equal(isValidPngFile({ ...valid, originalname: "signature.gif" }), false);
  assert.equal(isValidPngFile({ ...valid, buffer: Buffer.from("not-a-png") }), false);
});

test("upload usa o bucket, o path do usuário e upsert, e a URL pública não contém segredo", async () => {
  const database = new FakeSupabase();
  const file = { originalname: "signature.png", mimetype: "image/png", buffer: PNG };

  const result = await uploadUserSignature(USER_ID, file, { supabase: database });
  assert.equal(database.uploads.length, 1);
  assert.equal(database.uploads[0].path, `${USER_ID}/signature.png`);
  assert.equal(database.uploads[0].options.upsert, true);
  assert.deepEqual(result, {
    enabled: true,
    has_signature: true,
    image_url: `https://project.supabase.co/storage/v1/object/public/${SIGNATURE_BUCKET}/${USER_ID}/signature.png?v=1788350400000`,
  });
  assert.equal(result.image_url.includes("service"), false);

  await uploadUserSignature(USER_ID, file, { supabase: database });
  assert.equal(database.uploads[1].path, database.uploads[0].path);
  assert.equal(signatureStoragePath(USER_ID), `${USER_ID}/signature.png`);
});

test("delete remove o arquivo esperado e limpa a configuração", async () => {
  const database = new FakeSupabase();
  database.user.signature_enabled = true;
  database.user.signature_storage_path = `${USER_ID}/signature.png`;

  await deleteUserSignature(USER_ID, { supabase: database });
  assert.deepEqual(database.removals, [[`${USER_ID}/signature.png`]]);
  assert.equal(database.user.signature_enabled, false);
  assert.equal(database.user.signature_storage_path, null);
});

test("HTML da assinatura é seguro, usa imagem pública no final e não altera a mensagem da timeline", () => {
  const html = composeTicketReplyHtml("Problema <corrigido>", {
    enabled: true,
    has_signature: true,
    content_id: "smartdesk-signature-test",
  });

  assert.match(html, /^<div>Problema &lt;corrigido&gt;<\/div><br><br><img/);
  assert.match(html, /alt="Assinatura"/);
  assert.match(html, /src="cid:smartdesk-signature-test"/);
  assert.match(html, /max-width:700px/);
  assert.equal(html.includes("https://"), false);
  assert.equal(html.includes("base64"), false);
  assert.equal(composeTicketReplyHtml("Resposta", { enabled: false }), "Resposta");
});
