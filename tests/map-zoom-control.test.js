const test = require("node:test");
const assert = require("node:assert/strict");
const ZoomControl = require("../map-zoom-control.js");

const createElement = (tagName) => {
  const attributes = new Map();
  const children = [];
  let textContent = "Leaflet default glyph";
  return {
    tagName,
    attributes,
    children,
    get textContent() { return textContent; },
    set textContent(value) { textContent = value; children.length = 0; },
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name) || null; },
    appendChild(child) { children.push(child); return child; }
  };
};

const makeControl = () => {
  const buttons = new Map([
    [".leaflet-control-zoom-in", createElement("a")],
    [".leaflet-control-zoom-out", createElement("a")]
  ]);
  return { buttons, querySelector(selector) { return buttons.get(selector) || null; } };
};

test("zoom control replaces text glyphs with centered, accessible dark-green SVG paths", () => {
  const control = makeControl();
  const documentRef = { createElementNS(namespace, tagName) { const element = createElement(tagName); element.namespaceURI = namespace; return element; } };
  const zoomIn = control.buttons.get(".leaflet-control-zoom-in");
  const zoomOut = control.buttons.get(".leaflet-control-zoom-out");

  assert.equal(ZoomControl.configure(control, documentRef), true);
  for (const [button, label, expectedPath] of [
    [zoomIn, "Увеличить масштаб", "M9 3v12M3 9h12"],
    [zoomOut, "Уменьшить масштаб", "M3 9h12"]
  ]) {
    assert.equal(button.getAttribute("role"), "button");
    assert.equal(button.getAttribute("aria-label"), label);
    assert.equal(button.title, label);
    assert.equal(button.textContent, "");
    const [svg] = button.children;
    assert.equal(svg.tagName, "svg");
    assert.equal(svg.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(svg.getAttribute("viewBox"), "0 0 18 18");
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    assert.equal(svg.getAttribute("focusable"), "false");
    const [path] = svg.children;
    assert.equal(path.getAttribute("d"), expectedPath);
    assert.equal(path.getAttribute("stroke"), "currentColor");
    assert.equal(path.getAttribute("stroke-width"), "2.5");
    assert.equal(path.getAttribute("stroke-linecap"), "round");
    assert.equal(path.getAttribute("stroke-linejoin"), "round");
  }
  assert.equal(control.buttons.get(".leaflet-control-zoom-in"), zoomIn, "Leaflet keeps the original clickable anchor");
  assert.equal(control.buttons.get(".leaflet-control-zoom-out"), zoomOut, "Leaflet keeps the original clickable anchor");
});

test("leaves an incomplete Leaflet control unchanged", () => {
  const control = { querySelector() { return null; } };
  const documentRef = { createElementNS() { throw new Error("No nodes should be created"); } };
  assert.equal(ZoomControl.configure(control, documentRef), false);
});
