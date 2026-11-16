// Cloudflare Worker that receives the website's contact and join forms and emails them on.
//
// The forms are plain HTML <form method="post"> (no JS needed); this Worker answers with a 303
// redirect back to the site's thank-you page, or to the form with ?error=<code>.
//
// Config: see wrangler.toml [vars] and the secrets listed in README.md.

import { buildContact, buildJoinRecord, contactEmail, joinBody, joinSummary, list } from "./format.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const site = env.SITE_URL.replace(/\/$/, "");

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Maltby Scouts forms endpoint\n", { headers: { "content-type": "text/plain" } });
    }
    if (request.method !== "POST" || !["/join", "/contact"].includes(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }

    const kind = url.pathname.slice(1);
    const back = (error) => Response.redirect(`${site}/${kind}/${error ? `?error=${error}` : "thanks/"}`, 303);

    // Only accept posts from our own pages (basic CSRF / drive-by spam protection).
    const origin = request.headers.get("origin") || request.headers.get("referer") || "";
    if (!allowedOrigins(env, site).some((o) => origin.startsWith(o))) {
      return new Response("Forbidden", { status: 403 });
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return back("invalid");
    }

    // Honeypot: real people never see this field. Pretend success so bots learn nothing.
    if ((form.get("website") || "") !== "") return back();

    if (!(await turnstileOk(env, form.get("cf-turnstile-response"), request.headers.get("cf-connecting-ip")))) {
      return back("captcha");
    }

    try {
      return kind === "join" ? await handleJoin(env, form, back) : await handleContact(env, form, back);
    } catch (e) {
      console.error(`${kind} failed`, e && e.stack ? e.stack : e);
      return back("send");
    }
  },
};

async function handleJoin(env, form, back) {
  const result = buildJoinRecord(form);
  if (!result.ok) {
    console.log("join validation failed", result.errors);
    return back("invalid");
  }
  const { record, extra } = result;
  record.entry_id = await nextEntryId(env);
  const who = record.join_type === "Young Person" ? record.young_persons_name : record.adults_name;

  // 1) Machine-readable copy for the OSM import script, in the old Scout Websites format.
  await sendEmail(env, {
    to: list(env.JOIN_SCRIPT_TO),
    subject: env.JOIN_SUBJECT || "New Join Enquiry",
    text: joinBody(record),
  });

  // 2) Optional human-readable copy for leaders. The enquiry is already safely with the OSM
  //    mailbox, so a failure here is logged rather than shown (which would invite a duplicate).
  const leaders = list(env.JOIN_NOTIFY_TO);
  if (leaders.length) {
    try {
      await sendEmail(env, {
        to: leaders,
        subject: `Join enquiry: ${who} (${record.join_type})`,
        text: joinSummary(record, extra),
        replyTo: record.email_address,
      });
    } catch (e) {
      console.error(`leader notification failed for entry ${record.entry_id}`, e);
    }
  }
  return back();
}

async function handleContact(env, form, back) {
  const result = buildContact(form);
  if (!result.ok) {
    console.log("contact validation failed", result.errors);
    return back("invalid");
  }
  const { subject, text } = contactEmail(result.contact);
  await sendEmail(env, { to: list(env.CONTACT_TO), subject, text, replyTo: result.contact.email_address });
  return back();
}

function allowedOrigins(env, site) {
  return [site, ...list(env.EXTRA_ORIGINS)];
}

async function turnstileOk(env, token, ip) {
  if (typeof token !== "string" || !token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await r.json();
  if (!data.success) console.log("turnstile rejected", data["error-codes"]);
  return Boolean(data.success);
}

/**
 * Sequential entry ids like the old site's ("634", "635", ...), kept in Workers KV.
 * KV isn't transactional, so two submissions in the same second could in theory share an id;
 * at a few enquiries a week that's acceptable, and the timestamp suffix fallback below keeps
 * ids unique if KV is unavailable.
 */
async function nextEntryId(env) {
  try {
    const current = parseInt((await env.COUNTER.get("join_entry_id")) || env.ENTRY_ID_START || "1000", 10);
    const next = current + 1;
    await env.COUNTER.put("join_entry_id", String(next));
    return String(next);
  } catch (e) {
    console.error("counter failed", e);
    return `web-${Date.now()}`;
  }
}

/** Send a plain-text email through Resend (https://resend.com/docs/api-reference/emails/send-email). */
async function sendEmail(env, { to, subject, text, replyTo }) {
  if (!to.length) throw new Error(`no recipients configured for "${subject}"`);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.FROM_ADDRESS, to, subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}
