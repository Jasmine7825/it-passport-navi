// ==========================================================
// ITパスポート合格ナビ — アプリロジック
// ==========================================================

const STORAGE_KEY = "itpass_state_v1";
const MAX_LEVEL = 10;
const LEVEL_UP_MIN_SETS = 5; // sets required at the current level (even with 80%+) before advancing

const LEVEL_MIX = {
  1: { basic: 0.90, applied: 0.10, past: 0.00 },
  2: { basic: 0.75, applied: 0.25, past: 0.00 },
  3: { basic: 0.60, applied: 0.35, past: 0.05 },
  4: { basic: 0.45, applied: 0.40, past: 0.15 },
  5: { basic: 0.30, applied: 0.40, past: 0.30 },
  6: { basic: 0.20, applied: 0.40, past: 0.40 },
  7: { basic: 0.15, applied: 0.35, past: 0.50 },
  8: { basic: 0.10, applied: 0.30, past: 0.60 },
  9: { basic: 0.05, applied: 0.25, past: 0.70 },
  10: { basic: 0.00, applied: 0.20, past: 0.80 },
};

const FIELD_ORDER = ["strategy", "management", "technology"];
const FIELD_LABEL = { strategy: "ストラテジ系", management: "マネジメント系", technology: "テクノロジ系" };
const FIELD_TAG_CLASS = { strategy: "tag-strategy", management: "tag-management", technology: "tag-technology" };

const PRACTICE_FIELD_COUNTS = { strategy: 4, management: 2, technology: 4 };
const MOCK_FULL = { size: 100, minutes: 120, fieldCounts: { strategy: 35, management: 20, technology: 45 } };
const MOCK_MINI = { size: 50, minutes: 60, fieldCounts: { strategy: 18, management: 10, technology: 22 } };

const LEVELUP_MESSAGES = [
  "🎉 レベルアップ!Lv.{n}になりました。着実に力がついています。",
  "🎉 すごい!Lv.{n}に到達。応用問題の比率が上がります、この調子で!",
  "🎉 レベルアップ!Lv.{n}です。合格がどんどん近づいています。",
  "🎉 Lv.{n}達成!今の勢いを大事にしていきましょう。",
  "🎉 レベルアップ!Lv.{n}になりました。次のレベルも狙っていきましょう。",
];
const MAXLEVEL_MESSAGE = "🏆 最高レベルLv.10に到達!過去問レベルが中心です。そろそろ模試で本番形式の実力を試してみましょう。";
const MAXLEVEL_KEEP_MESSAGE = "✨ MAXレベル維持中!安定した実力です。";
const MILESTONE_MESSAGE = "🎉 累計{n}問達成!ここまでの正答率は{pct}%です。よく頑張りました。";

// ---------------------------------------------------------
// State
// ---------------------------------------------------------
function defaultState() {
  return {
    totalAnswered: 0,
    totalCorrect: 0,
    level: 1,
    setsAtLevel: 0,
    fieldStats: {
      strategy: { answered: 0, correct: 0 },
      management: { answered: 0, correct: 0 },
      technology: { answered: 0, correct: 0 },
    },
    wrongQuestionIds: [],
    studyLog: {},
    mockHistory: [],
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return Object.assign(base, parsed, {
      fieldStats: Object.assign(base.fieldStats, parsed.fieldStats || {}),
    });
  } catch (e) {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("状態の保存に失敗しました", e);
  }
}

let state = loadState();
let session = null;

// ---------------------------------------------------------
// Question helpers
// ---------------------------------------------------------
const QUESTIONS_BY_ID = {};
QUESTIONS.forEach(q => { QUESTIONS_BY_ID[q.id] = q; });

function questionsByFieldDifficulty(field, difficulty) {
  return QUESTIONS.filter(q => q.field === field && q.difficulty === difficulty);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandom(arr, n) {
  return shuffle(arr).slice(0, Math.max(0, Math.min(n, arr.length)));
}

// questions.js always lists the correct choice first (answer: 0). Shuffle
// the choice order per presentation so the correct answer isn't always in
// the same position — done once when a question set is picked (not at
// render time), so navigating back and forth within a session doesn't
// re-shuffle under an already-recorded answer index.
function withShuffledChoices(q) {
  const order = shuffle(q.choices.map((_, i) => i));
  const choices = order.map(i => q.choices[i]);
  const answer = order.indexOf(q.answer);
  return Object.assign({}, q, { choices, answer });
}

function roundToSum(rawArr, total) {
  const floors = rawArr.map(Math.floor);
  const sum = floors.reduce((a, b) => a + b, 0);
  const remainder = total - sum;
  const order = rawArr
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder && order.length > 0; k++) {
    floors[order[k % order.length].i]++;
  }
  return floors;
}

function pickWeightedForField(field, count, mix) {
  if (count <= 0) return [];
  const diffs = ["basic", "applied", "past"];
  const rawCounts = diffs.map(d => mix[d] * count);
  const counts = roundToSum(rawCounts, count);

  let picked = [];
  diffs.forEach((d, i) => {
    const pool = questionsByFieldDifficulty(field, d);
    picked = picked.concat(pickRandom(pool, counts[i]));
  });

  if (picked.length < count) {
    const already = new Set(picked.map(q => q.id));
    const fallbackPool = QUESTIONS.filter(q => q.field === field && !already.has(q.id));
    picked = picked.concat(pickRandom(fallbackPool, count - picked.length));
  }
  return picked.slice(0, count);
}

function pickPracticeQuestions() {
  const mix = LEVEL_MIX[Math.min(state.level, MAX_LEVEL)];
  let selected = [];
  FIELD_ORDER.forEach(field => {
    selected = selected.concat(pickWeightedForField(field, PRACTICE_FIELD_COUNTS[field], mix));
  });
  return shuffle(selected).map(withShuffledChoices);
}

function pickMockQuestions(config) {
  let selected = [];
  FIELD_ORDER.forEach(field => {
    const pool = QUESTIONS.filter(q => q.field === field);
    selected = selected.concat(pickRandom(pool, config.fieldCounts[field]));
  });
  return shuffle(selected).map(withShuffledChoices);
}

function pickReviewQuestions() {
  const pool = state.wrongQuestionIds.map(id => QUESTIONS_BY_ID[id]).filter(Boolean);
  return shuffle(pool).slice(0, 10).map(withShuffledChoices);
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function checkMilestone(before, after) {
  const b = Math.floor(before / 100);
  const a = Math.floor(after / 100);
  return a > b ? a * 100 : null;
}

// ---------------------------------------------------------
// View routing
// ---------------------------------------------------------
function showView(viewId) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
  document.getElementById("btn-header-home").hidden = (viewId === "view-home");
  window.scrollTo(0, 0);
}

function goHome() {
  session = null;
  renderHome();
  showView("view-home");
}

// ---------------------------------------------------------
// Home view
// ---------------------------------------------------------
function renderHome() {
  document.getElementById("home-level").textContent = "Lv." + state.level;
  document.getElementById("header-level").textContent = "Lv." + state.level;
  document.getElementById("home-level-progress").textContent =
    state.level < MAX_LEVEL ? "このレベルでの演習 " + state.setsAtLevel + "/" + LEVEL_UP_MIN_SETS + "セット" : "MAXレベル";
  document.getElementById("home-total-answered").textContent = state.totalAnswered + "問";

  const overallPct = state.totalAnswered ? Math.round((state.totalCorrect / state.totalAnswered) * 100) : null;
  document.getElementById("home-overall-accuracy").textContent = overallPct === null ? "-" : overallPct + "%";

  renderFieldChart("home-field-chart");

  const reviewCount = state.wrongQuestionIds.length;
  document.getElementById("home-review-count").textContent = reviewCount;
  document.getElementById("btn-start-review").disabled = reviewCount === 0;

  renderRecentLog();
}

function renderFieldChart(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  FIELD_ORDER.forEach(field => {
    const stats = state.fieldStats[field];
    const pct = stats.answered ? Math.round((stats.correct / stats.answered) * 100) : 0;
    const row = document.createElement("div");
    row.className = "field-bar-row";
    row.innerHTML =
      '<span class="field-bar-name">' + FIELD_LABEL[field] + "</span>" +
      '<div class="field-bar-track"><div class="field-bar-fill" style="width:' + pct + "%; background:var(--color-" + field + ');"></div></div>' +
      '<span class="field-bar-pct">' + (stats.answered ? pct + "%" : "-") + "</span>";
    container.appendChild(row);
  });
}

function renderRecentLog() {
  const el = document.getElementById("home-recent-log");
  const entries = Object.entries(state.studyLog).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5);
  if (entries.length === 0) {
    el.textContent = "まだ記録がありません。さっそく演習を始めましょう!";
    return;
  }
  el.innerHTML = entries.map(([date, count]) =>
    '<div class="log-row"><span>' + date + "</span><span>" + count + "問</span></div>"
  ).join("");
}

// ---------------------------------------------------------
// Practice / Review flow (shared view)
// ---------------------------------------------------------
function startPractice() {
  session = { mode: "practice", questions: pickPracticeQuestions(), index: 0, answers: [], totalBefore: state.totalAnswered };
  runPracticeQuestion();
  showView("view-practice");
}

function startReview() {
  const qs = pickReviewQuestions();
  if (qs.length === 0) return;
  session = { mode: "review", questions: qs, index: 0, answers: [], totalBefore: state.totalAnswered };
  runPracticeQuestion();
  showView("view-practice");
}

function runPracticeQuestion() {
  const q = session.questions[session.index];
  const total = session.questions.length;
  document.getElementById("practice-progress").textContent =
    (session.mode === "review" ? "復習 " : "問 ") + (session.index + 1) + "/" + total;

  const metaEl = document.getElementById("practice-meta");
  metaEl.textContent = FIELD_LABEL[q.field];
  metaEl.className = "question-meta " + FIELD_TAG_CLASS[q.field];

  document.getElementById("practice-question").textContent = q.question;

  const choicesEl = document.getElementById("practice-choices");
  choicesEl.innerHTML = "";
  q.choices.forEach((choice, i) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.textContent = choice;
    btn.addEventListener("click", () => answerPractice(i));
    choicesEl.appendChild(btn);
  });

  document.getElementById("practice-feedback").hidden = true;
}

function answerPractice(choiceIndex) {
  const q = session.questions[session.index];
  const correct = choiceIndex === q.answer;
  session.answers.push({ id: q.id, correct });

  state.totalAnswered++;
  if (correct) state.totalCorrect++;
  state.fieldStats[q.field].answered++;
  if (correct) state.fieldStats[q.field].correct++;

  if (correct) {
    state.wrongQuestionIds = state.wrongQuestionIds.filter(id => id !== q.id);
  } else if (!state.wrongQuestionIds.includes(q.id)) {
    state.wrongQuestionIds.push(q.id);
  }

  state.studyLog[todayKey()] = (state.studyLog[todayKey()] || 0) + 1;
  saveState();

  const buttons = document.querySelectorAll("#practice-choices .choice-btn");
  buttons.forEach((btn, i) => {
    btn.disabled = true;
    if (i === q.answer) btn.classList.add("is-correct");
    else if (i === choiceIndex) btn.classList.add("is-incorrect");
    else btn.classList.add("is-dim");
  });

  const label = document.getElementById("practice-result-label");
  label.textContent = correct ? "✅ 正解!" : "❌ 不正解";
  label.className = "feedback-label " + (correct ? "is-correct" : "is-incorrect");
  document.getElementById("practice-explanation").textContent = q.explanation;
  document.getElementById("practice-feedback").hidden = false;
}

function finishPracticeSet() {
  const total = session.answers.length;
  const correctCount = session.answers.filter(a => a.correct).length;
  const pct = Math.round((correctCount / total) * 100);

  let leveledUp = false, reachedMax = false, stayedAtMax = false, setsUntilNext = null;

  if (session.mode === "practice") {
    state.setsAtLevel++;
    if (pct >= 80) {
      if (state.level < MAX_LEVEL) {
        if (state.setsAtLevel >= LEVEL_UP_MIN_SETS) {
          state.level++;
          state.setsAtLevel = 0;
          leveledUp = true;
          reachedMax = (state.level === MAX_LEVEL);
        } else {
          setsUntilNext = LEVEL_UP_MIN_SETS - state.setsAtLevel;
        }
      } else {
        stayedAtMax = true;
      }
    }
  }

  const milestone = checkMilestone(session.totalBefore, state.totalAnswered);
  saveState();

  renderSetComplete({ pct, total, correctCount, leveledUp, reachedMax, stayedAtMax, setsUntilNext, milestone });
  showView("view-set-complete");
}

function renderSetComplete({ pct, total, correctCount, leveledUp, reachedMax, stayedAtMax, setsUntilNext, milestone }) {
  document.getElementById("setcomplete-heading").textContent =
    session.mode === "review" ? "復習お疲れさまでした!" : "10問お疲れさまでした!";
  document.getElementById("setcomplete-accuracy").textContent = pct + "% (" + correctCount + "/" + total + ")";
  document.getElementById("setcomplete-total").textContent = state.totalAnswered + "問";

  const levelupBanner = document.getElementById("setcomplete-levelup-banner");
  const maxlevelBanner = document.getElementById("setcomplete-maxlevel-banner");
  const milestoneBanner = document.getElementById("setcomplete-milestone-banner");
  const nextlevelNote = document.getElementById("setcomplete-nextlevel-note");
  levelupBanner.hidden = true;
  maxlevelBanner.hidden = true;
  milestoneBanner.hidden = true;
  nextlevelNote.hidden = true;

  if (leveledUp && reachedMax) {
    maxlevelBanner.hidden = false;
    document.getElementById("maxlevel-message").textContent = MAXLEVEL_MESSAGE;
  } else if (leveledUp) {
    levelupBanner.hidden = false;
    const msg = LEVELUP_MESSAGES[Math.floor(Math.random() * LEVELUP_MESSAGES.length)];
    document.getElementById("levelup-message").textContent = msg.replace("{n}", state.level);
  } else if (stayedAtMax) {
    maxlevelBanner.hidden = false;
    document.getElementById("maxlevel-message").textContent = MAXLEVEL_KEEP_MESSAGE;
  } else if (setsUntilNext !== null) {
    nextlevelNote.hidden = false;
    document.getElementById("nextlevel-message").textContent =
      "🌱 正答率80%以上でした!このレベルでの演習は" + state.setsAtLevel + "/" + LEVEL_UP_MIN_SETS +
      "セット目。あと" + setsUntilNext + "セットでレベルアップに挑戦できます。";
  }

  if (milestone) {
    milestoneBanner.hidden = false;
    const overallPct = Math.round((state.totalCorrect / state.totalAnswered) * 100);
    document.getElementById("milestone-message").textContent =
      MILESTONE_MESSAGE.replace("{n}", milestone).replace("{pct}", overallPct);
  }

  document.getElementById("btn-continue-next-set").textContent =
    session.mode === "review" ? "復習を続ける ▶" : "次の10問へ ▶";
  document.getElementById("header-level").textContent = "Lv." + state.level;
}

// ---------------------------------------------------------
// Mock exam flow
// ---------------------------------------------------------
function startMock(type) {
  const config = type === "full" ? MOCK_FULL : MOCK_MINI;
  session = {
    mode: "mock",
    mockType: type,
    config,
    questions: pickMockQuestions(config),
    index: 0,
    answers: new Array(config.size).fill(null),
    secondsLeft: config.minutes * 60,
    totalBefore: state.totalAnswered,
    timerId: null,
  };
  document.getElementById("mock-title").textContent = (type === "full" ? "模試(フル 100問)" : "模試(ミニ 50問)");
  runMockQuestion();
  startMockTimer();
  showView("view-mock");
}

function startMockTimer() {
  updateMockTimerDisplay();
  session.timerId = setInterval(() => {
    session.secondsLeft--;
    updateMockTimerDisplay();
    if (session.secondsLeft <= 0) {
      clearInterval(session.timerId);
      submitMock();
    }
  }, 1000);
}

function updateMockTimerDisplay() {
  const m = Math.max(0, Math.floor(session.secondsLeft / 60));
  const s = Math.max(0, session.secondsLeft % 60);
  document.getElementById("mock-timer").textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function runMockQuestion() {
  const q = session.questions[session.index];
  document.getElementById("mock-progress").textContent = "問 " + (session.index + 1) + "/" + session.questions.length;

  const metaEl = document.getElementById("mock-meta");
  metaEl.textContent = FIELD_LABEL[q.field];
  metaEl.className = "question-meta " + FIELD_TAG_CLASS[q.field];

  document.getElementById("mock-question").textContent = q.question;

  const choicesEl = document.getElementById("mock-choices");
  choicesEl.innerHTML = "";
  const chosen = session.answers[session.index];
  q.choices.forEach((choice, i) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn" + (chosen === i ? " is-selected" : "");
    btn.textContent = choice;
    btn.addEventListener("click", () => {
      session.answers[session.index] = i;
      runMockQuestion();
    });
    choicesEl.appendChild(btn);
  });

  renderMockPalette();
}

function renderMockPalette() {
  const el = document.getElementById("mock-palette");
  el.innerHTML = "";
  session.questions.forEach((q, i) => {
    const btn = document.createElement("button");
    btn.className = "palette-btn" +
      (i === session.index ? " is-current" : "") +
      (session.answers[i] !== null ? " is-answered" : "");
    btn.textContent = i + 1;
    btn.addEventListener("click", () => { session.index = i; runMockQuestion(); });
    el.appendChild(btn);
  });
}

function submitMock() {
  if (session.timerId) clearInterval(session.timerId);

  const fieldResult = {};
  FIELD_ORDER.forEach(f => { fieldResult[f] = { correct: 0, total: 0 }; });

  let correctCount = 0;
  const wrongItems = [];

  session.questions.forEach((q, i) => {
    const chosen = session.answers[i];
    const correct = chosen === q.answer;
    fieldResult[q.field].total++;
    if (correct) { fieldResult[q.field].correct++; correctCount++; }

    state.totalAnswered++;
    if (correct) state.totalCorrect++;
    state.fieldStats[q.field].answered++;
    if (correct) state.fieldStats[q.field].correct++;

    if (correct) {
      state.wrongQuestionIds = state.wrongQuestionIds.filter(id => id !== q.id);
    } else {
      if (!state.wrongQuestionIds.includes(q.id)) state.wrongQuestionIds.push(q.id);
      wrongItems.push({ q, chosen });
    }
  });

  state.studyLog[todayKey()] = (state.studyLog[todayKey()] || 0) + session.questions.length;

  const totalScore = Math.round((correctCount / session.questions.length) * 1000);
  const fieldScores = {};
  FIELD_ORDER.forEach(f => {
    const r = fieldResult[f];
    fieldScores[f] = r.total ? Math.round((r.correct / r.total) * 1000) : 0;
  });
  const pass = totalScore >= 600 && FIELD_ORDER.every(f => fieldScores[f] >= 300);

  state.mockHistory.push({
    date: new Date().toISOString(),
    type: session.mockType,
    score: totalScore,
    fieldScores,
    pass,
  });

  const milestone = checkMilestone(session.totalBefore, state.totalAnswered);
  saveState();

  renderMockResult({ totalScore, fieldScores, pass, wrongItems, milestone });
  showView("view-mock-result");
}

function renderMockResult({ totalScore, fieldScores, pass, wrongItems, milestone }) {
  const banner = document.getElementById("mockresult-banner");
  banner.className = "banner banner-result " + (pass ? "is-pass" : "is-fail");
  let headline = pass ? "🎉 合格ライン突破です!おめでとうございます!" : "😢 今回は合格ラインに届きませんでした。";
  if (milestone) headline += "(累計" + milestone + "問達成!)";
  document.getElementById("mockresult-headline").textContent = headline;

  document.getElementById("mockresult-total-score").textContent = totalScore + " 点";

  const table = document.getElementById("mockresult-field-scores");
  table.innerHTML = "<tr><th>分野</th><th>得点</th><th>判定</th></tr>" +
    FIELD_ORDER.map(f => {
      const ok = fieldScores[f] >= 300;
      return "<tr><td>" + FIELD_LABEL[f] + "</td><td>" + fieldScores[f] + "点</td><td>" + (ok ? "✅" : "❌ 300点未満") + "</td></tr>";
    }).join("");

  const wrongEl = document.getElementById("mockresult-wrong-list");
  if (wrongItems.length === 0) {
    wrongEl.innerHTML = "<p>全問正解でした!素晴らしいです。</p>";
  } else {
    wrongEl.innerHTML = wrongItems.map(({ q, chosen }) =>
      '<div class="wrong-item">' +
      '<div class="question-meta ' + FIELD_TAG_CLASS[q.field] + '">' + FIELD_LABEL[q.field] + "</div>" +
      '<div class="wq-question">' + q.question + "</div>" +
      '<div class="wq-answer">正解: ' + q.choices[q.answer] + (chosen === null ? "(未回答)" : "") + "</div>" +
      '<div class="wq-explanation">' + q.explanation + "</div>" +
      "</div>"
    ).join("");
  }

  document.getElementById("header-level").textContent = "Lv." + state.level;
}

// ---------------------------------------------------------
// Stats view
// ---------------------------------------------------------
function renderStats() {
  renderFieldChart("stats-field-chart");

  const logEl = document.getElementById("stats-study-log");
  const entries = Object.entries(state.studyLog).sort((a, b) => b[0].localeCompare(a[0]));
  logEl.innerHTML = entries.length === 0
    ? "<p>まだ記録がありません。</p>"
    : entries.map(([date, count]) =>
        '<div class="log-row"><span>' + date + "</span><span>" + count + "問</span></div>"
      ).join("");

  const mockEl = document.getElementById("stats-mock-history");
  if (state.mockHistory.length === 0) {
    mockEl.innerHTML = "<p>まだ模試の受験履歴がありません。</p>";
  } else {
    mockEl.innerHTML = state.mockHistory.slice().reverse().map(r => {
      const d = new Date(r.date);
      const dateStr = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " +
        String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      const typeLabel = r.type === "full" ? "フル模試" : "ミニ模試";
      return '<div class="log-row"><span>' + dateStr + " " + typeLabel + "</span><span>" + r.score +
        '点 <span class="mock-badge ' + (r.pass ? "is-pass" : "is-fail") + '">' + (r.pass ? "合格" : "不合格") + "</span></span></div>";
    }).join("");
  }
}

// ---------------------------------------------------------
// Passcode gate (a casual-visitor deterrent, not real security —
// this is a public static site, so the check itself is inspectable)
// ---------------------------------------------------------
const PASSCODE_HASH = 1622439583;

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function initPasscodeGate() {
  const gate = document.getElementById("passcode-gate");
  if (localStorage.getItem("itpass_unlocked") === "1") {
    gate.hidden = true;
    return;
  }
  const input = document.getElementById("passcode-input");
  const error = document.getElementById("passcode-error");
  function tryUnlock() {
    if (simpleHash(input.value.trim()) === PASSCODE_HASH) {
      localStorage.setItem("itpass_unlocked", "1");
      gate.hidden = true;
    } else {
      error.hidden = false;
      input.value = "";
      input.focus();
    }
  }
  document.getElementById("btn-passcode-submit").addEventListener("click", tryUnlock);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
  input.focus();
}
initPasscodeGate();

// ---------------------------------------------------------
// Manual sync (export/import a portable progress code)
// ---------------------------------------------------------
const SYNC_PREFIX = "ITPASS1:";
const QR_MAX_LENGTH = 900; // empirically verified reliable encode+scan limit for this library

function buildSyncCode() {
  const json = JSON.stringify(state);
  const b64 = btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return SYNC_PREFIX + b64;
}

function parseSyncCode(code) {
  code = code.trim();
  if (!code.startsWith(SYNC_PREFIX)) {
    throw new Error("コードの先頭が正しくありません。コピーし忘れ・貼り付けミスがないか確認してください。");
  }
  const b64 = code.slice(SYNC_PREFIX.length);
  const json = decodeURIComponent(atob(b64).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  const parsed = JSON.parse(json);
  if (typeof parsed.totalAnswered !== "number" || typeof parsed.level !== "number" || !parsed.fieldStats) {
    throw new Error("コードの中身が想定と異なります。");
  }
  return parsed;
}

function summarizeState(s) {
  const pct = s.totalAnswered ? Math.round((s.totalCorrect / s.totalAnswered) * 100) : 0;
  return "Lv." + s.level + " / 累計" + s.totalAnswered + "問 / 正答率" + pct + "%";
}

function renderSyncQr(code) {
  const wrap = document.getElementById("sync-qr-wrap");
  const url = location.href.split("#")[0] + "#sync=" + encodeURIComponent(code);
  if (typeof QRCodeLib === "undefined" || url.length > QR_MAX_LENGTH) {
    wrap.hidden = true;
    return;
  }
  const canvas = document.getElementById("sync-qr-canvas");
  QRCodeLib.toCanvas(canvas, url, { width: 220, margin: 2, errorCorrectionLevel: "M" })
    .then(() => { wrap.hidden = false; })
    .catch(() => { wrap.hidden = true; });
}

// If opened via a QR scan / shared sync link (#sync=<code>), offer to import it.
function checkSyncHashOnLoad() {
  const hash = location.hash;
  if (!hash.startsWith("#sync=")) return;
  const raw = decodeURIComponent(hash.slice("#sync=".length));
  history.replaceState(null, "", location.pathname + location.search);
  let incoming;
  try {
    incoming = parseSyncCode(raw);
  } catch (e) {
    alert("読み込めませんでした。" + e.message);
    return;
  }
  const msg = "読み込んだコードの内容: " + summarizeState(incoming) + "\n" +
    "今のこの端末: " + summarizeState(state) + "\n\n" +
    "この端末のデータを上書きします。よろしいですか?";
  if (!confirm(msg)) return;
  state = Object.assign(defaultState(), incoming);
  saveState();
  renderHome();
}

// ---------------------------------------------------------
// Event wiring
// ---------------------------------------------------------
document.getElementById("btn-start-practice").addEventListener("click", startPractice);
document.getElementById("btn-start-review").addEventListener("click", startReview);
document.getElementById("btn-start-mock-full").addEventListener("click", () => startMock("full"));
document.getElementById("btn-start-mock-mini").addEventListener("click", () => startMock("mini"));
document.getElementById("btn-view-stats").addEventListener("click", () => { renderStats(); showView("view-stats"); });
document.getElementById("btn-stats-back").addEventListener("click", goHome);
document.getElementById("btn-sync-export").addEventListener("click", () => {
  const code = buildSyncCode();
  document.getElementById("sync-export-code").value = code;
  document.getElementById("sync-export-result").hidden = false;
  renderSyncQr(code);
});
document.getElementById("btn-sync-copy").addEventListener("click", async () => {
  const code = document.getElementById("sync-export-code").value;
  try {
    await navigator.clipboard.writeText(code);
    alert("コピーしました。他の端末の「読み込む」欄に貼り付けてください。");
  } catch (e) {
    document.getElementById("sync-export-code").select();
    alert("自動コピーに失敗しました。テキストを選択したので、手動でコピー(Ctrl+C)してください。");
  }
});
document.getElementById("btn-sync-import").addEventListener("click", () => {
  const raw = document.getElementById("sync-import-input").value;
  let incoming;
  try {
    incoming = parseSyncCode(raw);
  } catch (e) {
    alert("読み込めませんでした。" + e.message);
    return;
  }
  const msg = "このコードの内容: " + summarizeState(incoming) + "\n" +
    "今のこの端末: " + summarizeState(state) + "\n\n" +
    "この端末のデータをコードの内容で上書きします。よろしいですか?";
  if (!confirm(msg)) return;
  state = Object.assign(defaultState(), incoming);
  saveState();
  document.getElementById("sync-import-input").value = "";
  renderHome();
  showView("view-home");
  alert("読み込みました。");
});

document.getElementById("btn-reset-data").addEventListener("click", () => {
  if (!confirm("本当に全ての学習データを削除しますか?レベル・累計解答数・正答率・復習リスト・学習履歴・模試履歴が消え、Lv.1からやり直しになります。この操作は取り消せません。")) return;
  state = defaultState();
  saveState();
  renderHome();
  showView("view-home");
});

document.getElementById("btn-practice-next").addEventListener("click", () => {
  session.index++;
  if (session.index >= session.questions.length) finishPracticeSet();
  else runPracticeQuestion();
});
document.getElementById("btn-practice-exit").addEventListener("click", () => {
  if (confirm("演習を中断してホームに戻りますか?ここまでの回答は記録されます。")) goHome();
});

document.getElementById("btn-continue-next-set").addEventListener("click", () => {
  if (session.mode === "review") {
    if (state.wrongQuestionIds.length === 0) { goHome(); return; }
    startReview();
  } else {
    startPractice();
  }
});
document.getElementById("btn-back-home").addEventListener("click", goHome);

document.getElementById("btn-mock-prev").addEventListener("click", () => {
  if (session.index > 0) { session.index--; runMockQuestion(); }
});
document.getElementById("btn-mock-next").addEventListener("click", () => {
  if (session.index < session.questions.length - 1) { session.index++; runMockQuestion(); }
});
document.getElementById("btn-mock-submit").addEventListener("click", () => {
  const unanswered = session.answers.filter(a => a === null).length;
  const msg = unanswered > 0 ? "未回答が" + unanswered + "問あります。このまま提出しますか?" : "提出しますか?";
  if (confirm(msg)) submitMock();
});
document.getElementById("btn-mockresult-home").addEventListener("click", goHome);

document.getElementById("btn-header-home").addEventListener("click", () => {
  const onPractice = document.getElementById("view-practice").classList.contains("active");
  const onMock = document.getElementById("view-mock").classList.contains("active");
  if (onPractice) {
    if (!confirm("演習を中断してホームに戻りますか?ここまでの回答は記録されます。")) return;
  }
  if (onMock) {
    if (!confirm("模試を中断してホームに戻りますか?回答内容は保存されません。")) return;
    if (session && session.timerId) clearInterval(session.timerId);
  }
  goHome();
});

// ---------------------------------------------------------
// Init
// ---------------------------------------------------------
renderHome();
showView("view-home");
checkSyncHashOnLoad();

// Offline support: only works over HTTPS (or localhost) — silently does
// nothing on plain http://<lan-ip> local-server access.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
