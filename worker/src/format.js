// Pure helpers (no Workers APIs) so they can be unit tested with `node --test`.

export const JOIN_TYPES = ["Young Person", "Adult Volunteer"];

/** Read a single-line text field: trimmed, newlines collapsed, length-capped. */
export function field(form, name, max = 200) {
  const v = form.get(name);
  if (typeof v !== "string") return "";
  return v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/** Read a multi-line text field (keeps newlines). */
export function textarea(form, name, max = 5000) {
  const v = form.get(name);
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").trim().slice(0, max);
}

/** "2022-12-12" (from <input type=date>) -> "12/12/2022". Returns "" if not a real date. */
export function ukDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return "";
  if (+y < 1900 || dt > new Date()) return "";
  return `${d}/${mo}/${y}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (v) => EMAIL_RE.test(v);

/**
 * Validate a join submission and build the record for the OSM import script.
 * Key names and order match what the old Scout Websites (Gravity Forms) notification sent.
 * Returns { ok: true, record, extra } or { ok: false, errors: [...] }.
 */
export function buildJoinRecord(form) {
  const joinType = field(form, "join_type", 30);
  const isYoung = joinType === "Young Person";
  const record = {
    entry_id: "", // filled in by the caller
    join_type: joinType,
    parent_name: isYoung ? field(form, "parent_name", 100) : "",
    young_persons_name: isYoung ? field(form, "young_persons_name", 100) : "",
    adults_name: isYoung ? "" : field(form, "adults_name", 100),
    date_of_birth: ukDate(field(form, "date_of_birth", 10)),
    email_address: field(form, "email_address", 200),
    telephone_number: field(form, "telephone_number", 30),
    address_1: field(form, "address_1", 200),
    address_2: field(form, "address_2", 200),
    post_code: field(form, "post_code", 10).toUpperCase(),
    city: field(form, "city", 100),
    country: field(form, "country", 60) || "United Kingdom",
  };

  const errors = [];
  if (!JOIN_TYPES.includes(joinType)) errors.push("join_type");
  if (isYoung) {
    if (!record.young_persons_name) errors.push("young_persons_name");
    if (!record.parent_name) errors.push("parent_name");
  } else if (!record.adults_name) {
    errors.push("adults_name");
  }
  if (!record.date_of_birth) errors.push("date_of_birth");
  if (!isEmail(record.email_address)) errors.push("email_address");
  if (!record.telephone_number) errors.push("telephone_number");
  for (const k of ["address_1", "post_code", "city"]) if (!record[k]) errors.push(k);
  if (field(form, "consent", 5) !== "yes") errors.push("consent");
  if (errors.length) return { ok: false, errors };

  // Extra answers that the OSM script doesn't take, but leaders should see.
  const extra = {
    volunteer_interest: form.getAll("volunteer_interest").filter((v) => typeof v === "string").map((v) => v.slice(0, 50)),
    parent_volunteer: field(form, "parent_volunteer", 5) === "Yes",
  };
  return { ok: true, record, extra };
}

/**
 * Serialise exactly like the old notification body, e.g.
 * { "entry_id": "634", "join_type": "Young Person", ... }
 */
export function joinBody(record) {
  return "{ " + Object.entries(record).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(String(v))}`).join(", ") + " }";
}

/** Human-readable summary of a join enquiry for leaders. */
export function joinSummary(record, extra) {
  const name = record.join_type === "Young Person" ? record.young_persons_name : record.adults_name;
  const lines = [
    `New ${record.join_type.toLowerCase()} join enquiry (entry ${record.entry_id})`,
    "",
    `Name: ${name}`,
    record.parent_name ? `Parent/carer: ${record.parent_name}` : null,
    `Date of birth: ${record.date_of_birth}`,
    `Email: ${record.email_address}`,
    `Telephone: ${record.telephone_number}`,
    `Address: ${[record.address_1, record.address_2, record.city, record.post_code].filter(Boolean).join(", ")}`,
    extra.volunteer_interest.length ? `Interested in: ${extra.volunteer_interest.join(", ")}` : null,
    extra.parent_volunteer ? "Parent/carer would like to hear about volunteering." : null,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

export const CONTACT_TYPES = ["General enquiry", "Joining enquiry", "Volunteering", "Feedback"];
export const SECTIONS = ["", "Squirrels", "Beavers", "Cubs", "Scouts"];

export function buildContact(form) {
  const c = {
    first_name: field(form, "first_name", 100),
    surname: field(form, "surname", 100),
    email_address: field(form, "email_address", 200),
    telephone_number: field(form, "telephone_number", 30),
    enquiry_type: field(form, "enquiry_type", 30),
    section: field(form, "section", 20),
    message: textarea(form, "message", 5000),
  };
  const errors = [];
  if (!c.first_name) errors.push("first_name");
  if (!c.surname) errors.push("surname");
  if (!isEmail(c.email_address)) errors.push("email_address");
  if (!CONTACT_TYPES.includes(c.enquiry_type)) errors.push("enquiry_type");
  if (!SECTIONS.includes(c.section)) errors.push("section");
  if (!c.message) errors.push("message");
  return errors.length ? { ok: false, errors } : { ok: true, contact: c };
}

export function contactEmail(c) {
  const subject = `Website enquiry: ${c.enquiry_type}${c.section ? ` (${c.section})` : ""} from ${c.first_name} ${c.surname}`;
  const text = [
    `Name: ${c.first_name} ${c.surname}`,
    `Email: ${c.email_address}`,
    c.telephone_number ? `Telephone: ${c.telephone_number}` : null,
    `Enquiry type: ${c.enquiry_type}`,
    c.section ? `Section: ${c.section}` : null,
    "",
    c.message,
    "",
    "Reply to this email to answer them directly.",
  ].filter((l) => l !== null).join("\n");
  return { subject, text };
}

/** "a@x.com, b@y.com" -> ["a@x.com", "b@y.com"] */
export const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
