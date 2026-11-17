const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
const css = fs.readFileSync(require.resolve("../styles.css"), "utf8");

test("idle status copy is omitted while active and GPS attention messages remain", () => {
  assert.match(html, /<html lang="ru">/);
  assert.match(html, /<div id="statusCopy" class="statusCopy" hidden><b id="statusTitle"><\/b><small id="statusText"><\/small><\/div>/);
  assert.doesNotMatch(html, /Готовы к прогулке\?|Нажмите "Начать прогулку"/);

  const setRecording = app.slice(app.indexOf("const setRecording = (active) =>"), app.indexOf("const refreshManualWarmupStart"));
  assert.match(setRecording, /: cancelling \? "Отступление" : ""/);
  assert.match(setRecording, /: cancelling \? "Останавливаем GPS и удаляем черновик…" : ""/);
  assert.match(setRecording, /\$\("statusCopy"\)\.hidden = !statusTitle && !statusText/);
  assert.match(setRecording, /"Стабилизация GPS\. Подождите перед началом движения…"/);
  assert.match(app, /"Точность GPS пока недостаточна для безопасного старта/);
  assert.match(app, /"Маршрут прерван\. Вернитесь к отмеченной точке/);
  assert.match(css, /\.statusCopy\[hidden\] \{ display: none; \}/);
});
