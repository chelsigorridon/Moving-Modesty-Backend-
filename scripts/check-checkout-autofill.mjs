import assert from "node:assert/strict";

// Every request deliberately has an empty cart: validation must reject it
// before any order/database/provider operation. No real customer data is used.
const input = {
  checkoutToken: "c4c5b18e-4e64-4d3b-845e-d6432157f723", stage: "complete", fulfilmentMethod: "delivery",
  customer: { firstName: "test", lastName: "CUSTOMER", email: " TEST@EXAMPLE.COM ", phone: " +27 (82) 123-4567 " },
  address: { line1: "10 Test Street", suburb: "test suburb", city: "cape town", province: " western cape ", postalCode: " 0081 " },
  items: [],
};
for (const [name, address, expected] of [
  ["case and autofill formatting accepted before empty-cart guard", input.address, /array|items/i],
  ["unknown province rejected", { ...input.address, province: "Atlantis" }, /province/i],
  ["invalid postcode rejected", { ...input.address, postalCode: "ABC" }, /postal code/i],
]) {
  const response = await fetch("https://movingmodesty.vercel.app/api/checkout/orders", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://holistic-brand-492217.framer.app" },
    body: JSON.stringify({ ...input, address }), signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  assert.equal(response.status, 400, "An empty cart must never create an order.");
  assert.equal(result.order, undefined); assert.match(result.error, expected);
  console.log(JSON.stringify({ check: name, status: response.status, passed: true }));
}
