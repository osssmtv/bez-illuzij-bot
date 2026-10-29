// Telegram-бот проекта «Без иллюзий» на Cloudflare Workers.
// Токен бота хранится в секрете BOT_TOKEN (настройки Worker'а в Cloudflare).
// После первого деплоя откройте https://<адрес-воркера>/setup - бот привяжет webhook сам.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.BOT_TOKEN) {
      return new Response("BOT_TOKEN не задан в настройках Worker'а", { status: 500 });
    }

    const secret = await webhookSecret(env.BOT_TOKEN);

    if (url.pathname === "/setup") {
      const result = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
      });
      return Response.json(result);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        await handleUpdate(update, env);
      } catch (err) {
        console.error(err);
      }
      return new Response("ok");
    }

    return new Response("Бот работает");
  },
};

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith("/start")) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "Здравствуйте! Это бот проекта «Без иллюзий».\n\n" +
        "Скоро здесь появится запись на консультацию и доступ в «Лабораторию».",
    });
    return;
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Пока я понимаю только команду /start.",
  });
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function webhookSecret(token) {
  const data = new TextEncoder().encode(`webhook:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}
