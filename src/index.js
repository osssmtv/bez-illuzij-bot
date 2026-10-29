// Бот проекта «Без иллюзий» на Cloudflare Workers.
//
// Что умеет:
// 1. Telegram-бот (@bez_illuzij_bot): меню с информацией с сайта.
// 2. MAX-бот: такое же меню в личных сообщениях.
// 3. Пересылка постов из канала MAX в канал Telegram.
//
// Секреты и переменные (Settings → Variables and secrets):
//   BOT_TOKEN       - токен Telegram-бота от BotFather (обязательно)
//   MAX_TOKEN       - токен MAX-бота (для меню в MAX и пересылки)
//   TG_CHANNEL      - канал Telegram, куда пересылать: @username или -100...
//   MAX_CHANNEL_ID  - (необязательно) id канала MAX, чтобы пересылать только из него
//
// После изменения настроек откройте https://<адрес-воркера>/setup

import { SECTIONS, keyboardFor } from "./content.js";

const MAX_API = "https://platform-api2.max.ru";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.BOT_TOKEN) {
      return new Response("BOT_TOKEN не задан в настройках Worker'а", { status: 500 });
    }

    const secret = await webhookSecret(env.BOT_TOKEN);

    if (url.pathname === "/setup") {
      return Response.json(await setup(env, url.origin, secret));
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
        return new Response("forbidden", { status: 403 });
      }
      await safe(() => handleTelegram(request, env));
      return new Response("ok");
    }

    if (url.pathname === "/max" && request.method === "POST") {
      if (request.headers.get("X-Max-Bot-Api-Secret") !== secret) {
        return new Response("forbidden", { status: 403 });
      }
      await safe(() => handleMax(request, env));
      return new Response("ok");
    }

    return new Response("Бот работает");
  },
};

// ---------- Настройка webhook'ов ----------

async function setup(env, origin, secret) {
  const report = {};

  report.telegram = await tg(env, "setWebhook", {
    url: `${origin}/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });

  if (env.MAX_TOKEN) {
    report.max = await max(env, "POST", "/subscriptions", {
      url: `${origin}/max`,
      update_types: ["message_created", "message_callback", "bot_started"],
      secret,
    });
  } else {
    report.max = "MAX_TOKEN не задан - MAX пока не подключён";
  }

  report.tg_channel = env.TG_CHANNEL || "TG_CHANNEL не задан - пересылка в Telegram выключена";
  return report;
}

// ---------- Telegram: меню ----------

async function handleTelegram(request, env) {
  const update = await request.json();

  if (update.callback_query) {
    const cq = update.callback_query;
    const id = SECTIONS[cq.data] ? cq.data : "start";
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    await tg(env, "editMessageText", {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: SECTIONS[id].text,
      reply_markup: tgKeyboard(id),
      disable_web_page_preview: true,
    });
    return;
  }

  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;

  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: SECTIONS.start.text,
    reply_markup: tgKeyboard("start"),
    disable_web_page_preview: true,
  });
}

function tgKeyboard(id) {
  return {
    inline_keyboard: keyboardFor(id).map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))
    ),
  };
}

// ---------- MAX: меню и пересылка ----------

async function handleMax(request, env) {
  if (!env.MAX_TOKEN) return;
  const update = await request.json();

  if (update.update_type === "bot_started") {
    await maxSend(env, `user_id=${update.user.user_id}`, "start");
    return;
  }

  if (update.update_type === "message_callback") {
    const id = SECTIONS[update.callback.payload] ? update.callback.payload : "start";
    await max(env, "POST", `/answers?callback_id=${encodeURIComponent(update.callback.callback_id)}`, {
      message: maxMessage(id),
    });
    return;
  }

  if (update.update_type !== "message_created") return;
  const msg = update.message;
  if (!msg || (msg.sender && msg.sender.is_bot)) return;

  const chatType = msg.recipient && msg.recipient.chat_type;
  const chatId = msg.recipient && msg.recipient.chat_id;

  if (chatType === "channel") {
    console.log("MAX channel post, chat_id =", chatId);
    if (env.MAX_CHANNEL_ID && String(chatId) !== String(env.MAX_CHANNEL_ID)) return;
    await crosspost(env, msg);
    return;
  }

  if (chatType === "dialog") {
    await maxSend(env, `chat_id=${chatId}`, "start");
  }
}

function maxMessage(id) {
  return {
    text: SECTIONS[id].text,
    attachments: [
      {
        type: "inline_keyboard",
        payload: {
          buttons: keyboardFor(id).map((row) =>
            row.map((b) =>
              b.url
                ? { type: "link", text: b.text, url: b.url }
                : { type: "callback", text: b.text, payload: b.data }
            )
          ),
        },
      },
    ],
  };
}

async function maxSend(env, target, id) {
  return max(env, "POST", `/messages?${target}`, maxMessage(id));
}

// Пост из канала MAX → канал Telegram.
async function crosspost(env, msg) {
  if (!env.TG_CHANNEL) return;

  const body = msg.body || (msg.link && msg.link.message) || {};
  const text = (body.text || "").trim();
  const attachments = body.attachments || [];

  const media = [];
  for (const a of attachments) {
    const p = a.payload || {};
    if (a.type === "image" && p.url) {
      media.push({ type: "photo", media: p.url });
    } else if (a.type === "video") {
      const videoUrl = await maxVideoUrl(env, p);
      if (videoUrl) media.push({ type: "video", media: videoUrl });
    }
  }

  const chat_id = env.TG_CHANNEL;
  const captionFits = text.length <= 1024;
  let res;

  if (media.length === 1) {
    const item = media[0];
    const method = item.type === "photo" ? "sendPhoto" : "sendVideo";
    res = await tg(env, method, {
      chat_id,
      [item.type]: item.media,
      ...(captionFits && text ? { caption: text } : {}),
    });
  } else if (media.length > 1) {
    const group = media.slice(0, 10).map((m, i) => (i === 0 && captionFits && text ? { ...m, caption: text } : m));
    res = await tg(env, "sendMediaGroup", { chat_id, media: group });
  }

  const mediaFailed = media.length > 0 && !(res && res.ok);
  if (mediaFailed) console.error("Telegram media send failed:", JSON.stringify(res));

  const needText = text && (media.length === 0 || !captionFits || mediaFailed);
  if (needText) {
    for (const part of splitText(text, 4096)) {
      await tg(env, "sendMessage", { chat_id, text: part, disable_web_page_preview: false });
    }
  }
}

async function maxVideoUrl(env, payload) {
  if (payload.url) return payload.url;
  if (!payload.token) return null;
  const info = await max(env, "GET", `/videos/${encodeURIComponent(payload.token)}`);
  const urls = (info && info.urls) || {};
  return urls.mp4_720 || urls.mp4_480 || urls.mp4_360 || urls.mp4_1080 || Object.values(urls)[0] || null;
}

// ---------- Вспомогательное ----------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function max(env, method, path, payload) {
  const res = await fetch(`${MAX_API}${path}`, {
    method,
    headers: { Authorization: env.MAX_TOKEN, "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, body: text };
  }
}

function splitText(text, limit) {
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function safe(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
}

async function webhookSecret(token) {
  const data = new TextEncoder().encode(`webhook:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}
