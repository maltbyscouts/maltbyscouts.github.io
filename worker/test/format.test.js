import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContact, buildJoinRecord, joinBody, joinSummary, ukDate } from "../src/format.js";

const fd = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) for (const x of [].concat(v)) f.append(k, x);
  return f;
};

const youngPerson = {
  join_type: "Young Person",
  young_persons_name: "Eisabeth Jackson",
  parent_name: "Bethanue Harly",
  date_of_birth: "2022-12-12",
  email_address: "Bethharly@outlook.com",
  telephone_number: "07323556311",
  address_1: "30 Cammery Drive",
  address_2: "",
  city: "Rotherham",
  post_code: "s62 2dj",
  country: "United Kingdom",
  consent: "yes",
};

test("join body matches the old Scout Websites format exactly", () => {
  const r = buildJoinRecord(fd(youngPerson));
  assert.equal(r.ok, true);
  r.record.entry_id = "634";
  assert.equal(
    joinBody(r.record),
    '{ "entry_id": "634", "join_type": "Young Person", "parent_name": "Bethanue Harly", "young_persons_name": "Eisabeth Jackson", "adults_name": "", "date_of_birth": "12/12/2022", "email_address": "Bethharly@outlook.com", "telephone_number": "07323556311", "address_1": "30 Cammery Drive", "address_2": "", "post_code": "S62 2DJ", "city": "Rotherham", "country": "United Kingdom" }',
  );
  // and it is valid JSON
  assert.equal(JSON.parse(joinBody(r.record)).date_of_birth, "12/12/2022");
});

test("adult volunteer clears young-person fields and needs adults_name", () => {
  const base = { ...youngPerson, join_type: "Adult Volunteer", date_of_birth: "1985-03-04" };
  assert.deepEqual(buildJoinRecord(fd(base)), { ok: false, errors: ["adults_name"] });
  const r = buildJoinRecord(fd({ ...base, adults_name: "Sam Smith", volunteer_interest: ["Becoming a Leader", "Support Roles"] }));
  assert.equal(r.ok, true);
  assert.equal(r.record.adults_name, "Sam Smith");
  assert.equal(r.record.parent_name, "");
  assert.equal(r.record.young_persons_name, "");
  assert.match(joinSummary({ ...r.record, entry_id: "1" }, r.extra), /Interested in: Becoming a Leader, Support Roles/);
});

test("join validation", () => {
  const r = buildJoinRecord(fd({ ...youngPerson, email_address: "nope", consent: "", date_of_birth: "2022-02-30" }));
  assert.deepEqual(r, { ok: false, errors: ["date_of_birth", "email_address", "consent"] });
  assert.equal(buildJoinRecord(fd({ ...youngPerson, join_type: "Hacker" })).ok, false);
});

test("JSON escaping survives quotes and newlines", () => {
  const r = buildJoinRecord(fd({ ...youngPerson, address_2: 'Flat "B"\r\nBack', parent_name: "Anne O'Neil" }));
  r.record.entry_id = "1";
  const parsed = JSON.parse(joinBody(r.record));
  assert.equal(parsed.address_2, 'Flat "B" Back');
  assert.equal(parsed.parent_name, "Anne O'Neil");
});

test("ukDate", () => {
  assert.equal(ukDate("2015-01-31"), "31/01/2015");
  assert.equal(ukDate("2015-02-29"), "");
  assert.equal(ukDate("31/01/2015"), "");
  assert.equal(ukDate("2999-01-01"), "");
});

test("contact form", () => {
  const ok = buildContact(fd({ first_name: "A", surname: "B", email_address: "a@b.co", enquiry_type: "Feedback", section: "Cubs", message: "Hi\r\nthere" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.contact.message, "Hi\nthere");
  assert.deepEqual(buildContact(fd({ first_name: "A", surname: "B", email_address: "a@b.co", enquiry_type: "Spam", message: "x" })).errors, ["enquiry_type"]);
});
