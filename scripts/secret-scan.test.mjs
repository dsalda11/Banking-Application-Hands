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

test("detects fake provider keys and bearer values without returning their values", () => {
  const fakeProviderKey = [
    "sk",
    "fake",
    "provider",
    "regression",
    "0123456789",
  ].join("-");
  const fakeBearer = ["Bearer", "fake.authorization.token.0123456789"].join(
    " ",
  );
  const content = [
    `key=${fakeProviderKey}`,
    `authorization: ${fakeBearer}`,
  ].join("\n");

  const findings = scanContent("fixture/config.txt", content);
  assert.deepEqual(
    findings.map(({ category }) => category).sort(),
    ["OpenAI API key", "bearer authorization value"].sort(),
  );
  assert.doesNotMatch(
    JSON.stringify(findings),
    new RegExp(`${fakeProviderKey}|${fakeBearer.replaceAll(".", "\\.")}`),
  );
});

test("rejects sensitive fields from retained evidence without returning fixture values", () => {
  const fieldNames = [
    ["banking", "Password"].join(""),
    "cookies",
    ["storage", "State"].join(""),
    ["operator", "Token"].join(""),
    ["rawProvider", "Request"].join(""),
    ["rawProvider", "Response"].join(""),
    ["provider", "Payload"].join(""),
  ];
  const fixtureValue = ["fake", "retained", "secret", "value"].join("-");
  const content = JSON.stringify(
    Object.fromEntries(fieldNames.map((name) => [name, fixtureValue])),
  );

  const findings = scanContent("evidence/fixture.json", content);
  assert.deepEqual(findings, [
    {
      category: "forbidden sensitive field in retained evidence",
      path: "evidence/fixture.json",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(fixtureValue));
});
