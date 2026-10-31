const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const MusicControl = require("../music-control.js");

const createAudio = () => ({
  paused: true,
  playCalls: 0,
  pauseCalls: 0,
  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  },
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
});

const createController = (audio, initialMuted = false) => {
  let muted = initialMuted;
  const savedMuteSettings = [];
  const control = MusicControl.createMusicControl({
    audio,
    isMuted: () => muted,
    setMuted: (value) => { muted = value; savedMuteSettings.push(value); }
  });
  return { control, isMuted: () => muted, savedMuteSettings };
};

test("music stays stopped on startup until location permission is confirmed", async () => {
  const audio = createAudio();
  const { control } = createController(audio);

  await control.start();
  control.setLocationAllowed(false);
  await control.start();

  assert.equal(control.isLocationAllowed(), false);
  assert.equal(audio.playCalls, 0);
  assert.equal(audio.paused, true);
});

test("revoking location permission immediately pauses music", async () => {
  const audio = createAudio();
  const { control } = createController(audio);
  control.setLocationAllowed(true);
  await control.start();
  assert.equal(audio.paused, false);

  control.setLocationAllowed(false);

  assert.equal(audio.paused, true);
  assert.equal(control.isLocationAllowed(), false);
});

test("restoring permission resumes the same audio without duplicate play requests", async () => {
  const audio = createAudio();
  const { control } = createController(audio);
  control.setLocationAllowed(true);
  await control.start();
  control.setLocationAllowed(true);
  assert.equal(audio.playCalls, 1);

  control.setLocationAllowed(false);
  control.setLocationAllowed(true);
  await control.start();

  assert.equal(audio.playCalls, 2);
  assert.equal(audio.paused, false);
});

test("concurrent permission and user-gesture events share one pending play request", async () => {
  const audio = createAudio();
  let finishPlay;
  audio.play = function () {
    this.playCalls += 1;
    this.paused = false;
    return new Promise((resolve) => { finishPlay = resolve; });
  };
  const { control } = createController(audio);

  control.setLocationAllowed(true);
  const firstRequest = control.start();
  const secondRequest = control.start();
  control.setLocationAllowed(true);

  assert.equal(firstRequest, secondRequest);
  assert.equal(audio.playCalls, 1);
  finishPlay();
  await firstRequest;
  assert.equal(audio.paused, false);
});

test("user mute preference survives permission loss and restoration", async () => {
  const audio = createAudio();
  const { control, isMuted, savedMuteSettings } = createController(audio, true);
  control.setLocationAllowed(true);
  await control.start();
  assert.equal(audio.playCalls, 0);

  await control.toggle();
  assert.equal(isMuted(), false);
  assert.equal(audio.playCalls, 1);

  await control.toggle();
  assert.equal(isMuted(), true);
  assert.equal(audio.paused, true);
  control.setLocationAllowed(false);
  control.setLocationAllowed(true);
  assert.equal(audio.playCalls, 1);
  assert.deepEqual(savedMuteSettings, [false, true]);
});

test("application gates music on permission state and wires the saved mute setting", () => {
  const app = fs.readFileSync(require.resolve("../app.js"), "utf8");
  assert.match(app, /localStorage\.getItem\(MUSIC_PREFERENCE_KEY\) === "true"/);
  assert.match(app, /MusicControl\.createMusicControl\(/);
  assert.match(app, /musicControl\.setLocationAllowed\(permission\.state === "granted"\)/);
  assert.match(app, /musicControl\.setLocationAllowed\(false\)/);
  assert.match(app, /locationPermissionDenied = false;\s*musicControl\.setLocationAllowed\(true\)/);
  assert.doesNotMatch(app, /backgroundMusic\.play\(/);
});
