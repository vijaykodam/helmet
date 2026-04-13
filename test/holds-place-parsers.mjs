import assert from "node:assert/strict";

import {
  extractHoldLinks,
  extractHoldPlaceForm,
  HoldFormUnavailableError,
  isUnauthenticatedHoldHtml,
  parseHoldActionResult,
} from "../dist/parsers/holds.js";

const holdingsFragment = `
  <div class="tab-pane">
    <a class="placehold btn btn-primary" href="/Record/helmet.2573580/Hold?sid=5314813797&level=title&hashKey=0f35b86091003af3304db57c854a8469#tabnav">
      Varaa teos
    </a>
  </div>
`;

const loginFragment = `
  <div class="lightbox-content">
    <a class="login-link" href="/MyResearch/CompleteLogin?lightbox=1">Kirjaudu</a>
    <form id="loginForm" action="/MyResearch/Home">
      <input type="hidden" name="processLogin" value="Kirjaudu">
    </form>
  </div>
`;

const holdFormFragment = `
  <div class="hold-form">
    <form method="post" name="placeHold">
      <select id="pickUpLocation" name="gatheredDetails[pickUpLocation]">
        <option value="h56al">Arabianranta / Arabiastranden</option>
        <option value="oodi" selected>Oodi</option>
      </select>
      <button name="placeHold" type="submit">Lähetä</button>
    </form>
  </div>
`;

const unavailableFragment = `
  <div class="hold-form">
    <div class="alert-warning">Varaus ei ole mahdollinen.</div>
  </div>
`;

const links = extractHoldLinks(holdingsFragment);
assert.equal(links.length, 1);
assert.equal(links[0].recordId, "helmet.2573580");
assert.equal(links[0].hashKey, "0f35b86091003af3304db57c854a8469");

assert.equal(isUnauthenticatedHoldHtml(loginFragment), true);
assert.equal(isUnauthenticatedHoldHtml(holdFormFragment), false);

const form = extractHoldPlaceForm(holdFormFragment);
assert.equal(form.pickupLocations.length, 2);
assert.equal(form.pickupLocations[1].selected, true);
assert.equal(form.pickupLocations[1].value, "oodi");

assert.throws(
  () => extractHoldPlaceForm(loginFragment),
  (err) =>
    err instanceof HoldFormUnavailableError && err.message.includes("Session expired"),
);

assert.throws(
  () => extractHoldPlaceForm(unavailableFragment),
  (err) =>
    err instanceof HoldFormUnavailableError
    && err.message.includes("Varaus ei ole mahdollinen"),
);

const loginResult = parseHoldActionResult(loginFragment);
assert.equal(loginResult.success, false);
assert.match(loginResult.message ?? "", /Session expired/i);

console.log("holds-place parser checks passed");
