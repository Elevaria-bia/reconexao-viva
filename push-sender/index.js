'use strict';

// ── ELEVARIA — Push Sender Worker ────────────────────────────
// Envia notificacoes push Web para todas as alunas cadastradas.
// Disparado via Cron Trigger do Cloudflare Workers.

// ── MENSAGENS POR TIPO ───────────────────────────────────────
const MSGS = {
  manha: [
    { title: 'Reconexao Viva', body: 'Bom dia. Seu ritual da manha esta esperando.' },
    { title: 'Reconexao Viva', body: 'A manha e so sua. Cinco minutos de presenca.' },
    { title: 'Reconexao Viva', body: 'Antes de comecar o dia — um momento para voce.' },
  ],
  agua_manha: [
    { title: 'Hidratacao', body: 'Voce bebeu agua hoje? Seu corpo agradece.' },
    { title: 'Hidratacao', body: 'Um copo de agua agora. Simples, poderoso.' },
  ],
  tarde: [
    { title: 'Reconexao Viva', body: 'Sua lingua esta no palato?' },
    { title: 'Reconexao Viva', body: 'Pausa de presenca. Voce lembrou de respirar?' },
    { title: 'Reconexao Viva', body: 'Um momento so seu, agora.' },
  ],
  agua_tarde: [
    { title: 'Hidratacao', body: 'Mais um copo antes de encerrar o dia.' },
    { title: 'Hidratacao', body: 'Hidratacao e autocuidado. Beba agua.' },
  ],
  noite: [
    { title: 'Reconexao Viva', body: 'Que tal encerrar o dia com presenca?' },
    { title: 'Reconexao Viva', body: 'O ritual da noite ainda te espera.' },
    { title: 'Reconexao Viva', body: 'Chegou a hora de soltar o dia.' },
  ],
};

function pickMsg(arr) {
  const idx = Math.floor(Date.now() / 86400000) % arr.length;
  return arr[idx];
}

function cronToType(cron) {
  if (cron === '0 10 * * *') return 'manha';
  if (cron === '0 14 * * *') return 'agua_manha';
  if (cron === '0 17 * * *') return 'tarde';
  if (cron === '0 22 * * *') return 'agua_tarde';
  if (cron === '0 0 * * *')  return 'noite';
  return 'manha';
}

// ── VAPID JWT (ES256) ────────────────────────────────────────
function b64urlToBytes(b64url) {
  const padding = '='.repeat((4 - b64url.length % 4) % 4);
  const b64 = (b64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Wraps raw 32-byte P-256 private key scalar into PKCS#8 DER
function rawPrivKeyToPkcs8(rawBytes) {
  // PKCS#8 DER prefix for EC P-256 private key (65 bytes total prefix + 32 key)
  const prefix = new Uint8Array([
    0x30, 0x41,                                     // SEQUENCE 65
    0x02, 0x01, 0x00,                               // INTEGER 0 (version)
    0x30, 0x13,                                     // SEQUENCE 19 (algorithm)
      0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID P-256
    0x04, 0x27,                                     // OCTET STRING 39
      0x30, 0x25,                                   // SEQUENCE 37
        0x02, 0x01, 0x01,                           // INTEGER 1 (ecPrivateKey version)
        0x04, 0x20,                                 // OCTET STRING 32 (key bytes follow)
  ]);
  const der = new Uint8Array(prefix.length + rawBytes.length);
  der.set(prefix);
  der.set(rawBytes, prefix.length);
  return der.buffer;
}

async function buildVapidJwt(endpoint, subject, vapidPrivateKeyB64url) {
  const url      = new URL(endpoint);
  const audience = url.origin;
  const expiry   = Math.floor(Date.now() / 1000) + 43200; // 12h

  const header  = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: expiry, sub: subject };

  const hB64  = bytesToB64url(new TextEncoder().encode(JSON.stringify(header)));
  const pB64  = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const input = `${hB64}.${pB64}`;

  const rawKey  = b64urlToBytes(vapidPrivateKeyB64url);
  const pkcs8   = rawPrivKeyToPkcs8(rawKey);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig    = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(input)
  );
  const sigB64 = bytesToB64url(new Uint8Array(sig));
  return `${input}.${sigB64}`;
}

// ── PAYLOAD ENCRYPTION (RFC 8291 aes128gcm) ─────────────────
async function encryptPayload(plaintext, subscriptionKeys) {
  const clientPublicKeyBytes = b64urlToBytes(subscriptionKeys.p256dh);
  const authBytes            = b64urlToBytes(subscriptionKeys.auth);

  // Gerar par de chaves ECDH efemero do servidor
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveBits']
  );

  // Exportar chave publica do servidor (65 bytes, formato nao comprimido)
  const serverPubKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)
  );

  // Importar chave publica do cliente
  const clientPublicKey = await crypto.subtle.importKey(
    'raw', clientPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // ECDH: derivar segredo compartilhado (32 bytes)
  const sharedSecretBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientPublicKey },
    serverKeyPair.privateKey, 256
  );
  const sharedSecret = new Uint8Array(sharedSecretBits);

  // Salt aleatorio (16 bytes)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF para derivar PRK e chaves de conteudo
  async function hkdfExtract(salt, ikm) {
    const saltKey = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  }
  async function hkdfExpand(prk, info, length) {
    const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    let output = new Uint8Array(0);
    let prev   = new Uint8Array(0);
    let counter = 0;
    while (output.length < length) {
      counter++;
      const block = new Uint8Array(prev.length + info.length + 1);
      block.set(prev); block.set(info, prev.length); block[block.length - 1] = counter;
      const t = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, block));
      const next = new Uint8Array(output.length + t.length);
      next.set(output); next.set(t, output.length);
      output = next;
      prev = t;
    }
    return output.slice(0, length);
  }

  // Contexto: "auth secret"
  const enc = new TextEncoder();
  const authInfo = enc.encode('Content-Encoding: auth\0');
  const prk = await hkdfExtract(authBytes, sharedSecret);
  const ikm = await hkdfExpand(prk, authInfo, 32);

  // Contexto para CEK e nonce
  function buildInfo(type, clientKey, serverKey) {
    const t = enc.encode(type);
    const info = new Uint8Array(t.length + 2 + 1 + 2 + clientKey.length + 2 + serverKey.length);
    let o = 0;
    info.set(t, o); o += t.length;
    info[o++] = 0; // nul
    info[o++] = 0; info[o++] = 65; info.set(clientKey, o); o += clientKey.length;
    info[o++] = 0; info[o++] = 65; info.set(serverKey, o);
    return info;
  }

  const cekInfo   = buildInfo(enc.encode('Content-Encoding: aesgcm\0P-256\0'), clientPublicKeyBytes, serverPubKeyRaw);
  const nonceInfo = buildInfo(enc.encode('Content-Encoding: nonce\0P-256\0'),  clientPublicKeyBytes, serverPubKeyRaw);

  const prkContent = await hkdfExtract(salt, ikm);
  const cekBytes   = await hkdfExpand(prkContent, cekInfo, 16);
  const nonceBytes = await hkdfExpand(prkContent, nonceInfo, 12);

  // AES-128-GCM encrypt
  const cek = await crypto.subtle.importKey('raw', cekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const data = enc.encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBytes }, cek, data)
  );

  return { salt, serverPubKey: serverPubKeyRaw, ciphertext };
}

// ── ENVIAR UM PUSH ───────────────────────────────────────────
async function sendOnePush(subscription, msg, env) {
  try {
    const jwt = await buildVapidJwt(subscription.endpoint, env.VAPID_SUBJECT, env.VAPID_PRIVATE_KEY);

    const { salt, serverPubKey, ciphertext } = await encryptPayload(
      JSON.stringify(msg),
      subscription.keys
    );

    // Montar cabecalho Crypto-Key e Encryption
    const serverPubB64 = btoa(String.fromCharCode(...serverPubKey)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const saltB64      = btoa(String.fromCharCode(...salt)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

    const resp = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization':    `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
        'Content-Encoding': 'aesgcm',
        'Content-Type':     'application/octet-stream',
        'Crypto-Key':       `dh=${serverPubB64}`,
        'Encryption':       `salt=${saltB64}`,
        'TTL':              '86400',
      },
      body: ciphertext,
    });

    if (!resp.ok && resp.status !== 201) {
      console.error(`Push failed for endpoint: ${resp.status}`, await resp.text());
      // Remover subscriptions expiradas (410 = Gone)
      if (resp.status === 410) return { expired: true, endpoint: subscription.endpoint };
    }
    return { ok: true };
  } catch (err) {
    console.error('sendOnePush error:', err);
    return { ok: false };
  }
}

// ── CRON HANDLER ─────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const type = cronToType(event.cron);
    const msg  = pickMsg(MSGS[type] || MSGS.manha);

    console.log(`[push-sender] cron=${event.cron} type=${type} msg="${msg.body}"`);

    // Buscar todas as subscriptions no Supabase (service role bypassa RLS)
    const resp = await fetch(
      `${env.SUPABASE_URL}/rest/v1/push_subscriptions?select=subscription`,
      {
        headers: {
          'apikey':        env.SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        }
      }
    );

    if (!resp.ok) {
      console.error('Falha ao buscar subscriptions:', await resp.text());
      return;
    }

    const rows = await resp.json();
    console.log(`[push-sender] ${rows.length} subscriptions encontradas`);

    const results = await Promise.allSettled(
      rows.map(row => sendOnePush(row.subscription, msg, env))
    );

    const sent    = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
    const expired = results.filter(r => r.status === 'fulfilled' && r.value?.expired).length;
    console.log(`[push-sender] enviadas=${sent} expiradas=${expired}`);
  },

  // Rota HTTP opcional para teste manual via browser
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/test-push' && request.method === 'GET') {
      // Dispara notificacao de teste
      const fakeEvent = { cron: '0 10 * * *' };
      ctx = { waitUntil: () => {} };
      await this.scheduled(fakeEvent, env, ctx);
      return new Response('Push de teste enviado.', { status: 200 });
    }
    return new Response('Elevaria Push Sender', { status: 200 });
  }
};
