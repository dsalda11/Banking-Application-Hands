import assert from "node:assert/strict";
import test from "node:test";

import { scanContent } from "./secret-scan.mjs";

test("detects fake hard-coded SMTP credentials without retaining their values", () => {
  const fakeUsername = "regression-user@example.invalid";
  const fakePassword = "fake-smtp-regression-password";
  const fixture = [
    `spring.mail.username=${fakeUsername}`,
    `spring.mail.password=${fakePassword}`,
  ].join("\n");

  const findings = scanContent("fixture/application.properties", fixture);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map(({ category, path }) => ({ category, path })),
    [
      {
        category: "hard-coded SMTP credential in spring.mail.username",
        path: "fixture/application.properties",
      },
      {
        category: "hard-coded SMTP credential in spring.mail.password",
        path: "fixture/application.properties",
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(findings),
    new RegExp(`${fakeUsername}|${fakePassword}`),
  );
});

test("allows runtime SMTP environment placeholders", () => {
  const fixture = [
    "spring.mail.username=${SPRING_MAIL_USERNAME:}",
    "spring.mail.password=${SPRING_MAIL_PASSWORD:}",
  ].join("\n");

  assert.deepEqual(
    scanContent("src/main/resources/application.properties", fixture),
    [],
  );
});
