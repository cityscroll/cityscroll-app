import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0;
  let opened = false;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      opened = true;
    } else if (source[i] === "}" && opened && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

function fixture() {
  const buttons = ["west", "north", "south", "east"].map((direction) => ({
    dataset: { mapPan: direction },
    addEventListener(_event, listener) {
      this.listener = listener;
    },
  }));
  const controls = {
    hidden: true,
    querySelectorAll() {
      return buttons;
    },
  };
  const calls = [];
  const map = {
    panBy(offset, options) {
      calls.push({ offset, options });
    },
  };
  const wireLandPanControls = new Function(
    "$",
    extractFunction("wireLandPanControls") + "\nreturn wireLandPanControls;",
  )(() => controls);
  return { buttons, calls, controls, map, wireLandPanControls };
}

test("map panning has four single-pointer alternatives to dragging", () => {
  const { buttons, calls, controls, map, wireLandPanControls } = fixture();
  wireLandPanControls(map);
  assert.equal(controls.hidden, false);

  for (const button of buttons) button.listener();
  assert.deepEqual(calls, [
    { offset: [-80, 0], options: { animate: false } },
    { offset: [0, -80], options: { animate: false } },
    { offset: [0, 80], options: { animate: false } },
    { offset: [80, 0], options: { animate: false } },
  ]);
});

test("pan controls meet the 24 CSS pixel target-size floor and label every direction", () => {
  assert.match(
    source,
    /\.map-pan-controls button\{width:32px;height:32px;/,
  );
  for (const direction of ["west", "north", "south", "east"]) {
    assert.match(source, new RegExp(`data-map-pan="${direction}"[^>]+aria-label=`));
  }
  assert.match(source, /wireLandPanControls\(landMap\)/);
});
