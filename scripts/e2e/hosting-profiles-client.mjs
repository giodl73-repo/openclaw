import assert from "node:assert/strict";

const [scenario, url] = process.argv.slice(2);
if (!scenario || !url) {
  throw new Error("usage: hosting-profiles-client.mjs <scenario> <ready-url>");
}

const response = await fetch(url);
const body = await response.json();

function condition(type) {
  const value = body.conditions?.find((entry) => entry.type === type);
  assert.ok(value, `missing ${type} condition: ${JSON.stringify(body)}`);
  return value;
}

if (scenario === "local") {
  assert.equal(response.status, 200);
  assert.equal(body.profile, "local");
  assert.equal(body.ready, true);
  assert.equal(condition("ProfileSelected").requirement, "required");
  assert.equal(condition("ConfigLoaded").requirement, "required");
  assert.equal(condition("GatewayResponding").requirement, "required");
  assert.equal(condition("PluginsLoaded").requirement, "advisory");
  assert.deepEqual(body.failures, []);
  assert.ok(Array.isArray(body.advisories));
} else if (scenario === "container-ready") {
  assert.equal(response.status, 200);
  assert.equal(body.profile, "container");
  assert.equal(body.ready, true);
  assert.equal(condition("ContainerStateReady").status, "True");
  assert.equal(condition("ContainerStateReady").requirement, "required");
  assert.deepEqual(body.failures, []);
} else if (scenario === "container-loopback") {
  assert.equal(response.status, 503);
  assert.equal(body.profile, "container");
  assert.equal(body.ready, false);
  assert.equal(condition("ContainerStateReady").status, "False");
  assert.equal(condition("ContainerStateReady").requirement, "required");
  assert.equal(condition("ContainerStateReady").reason, "ContainerGatewayLoopback");
  assert.ok(body.failures.includes("ContainerGatewayLoopback"));
} else {
  throw new Error(`unknown hosting profile scenario: ${scenario}`);
}

console.log(JSON.stringify({ scenario, status: response.status, readiness: body }, null, 2));
