(() => {
  "use strict";

  const DATA_BASE = "./data";
  const AUTO_FOLLOW_THRESHOLD_PX = 32;
  const SCROLL_BACK_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
  const SCROLL_FORWARD_KEYS = new Set(["ArrowDown", "PageDown", "End"]);

  const state = {
    manifest: null,
    example: null,
    exampleId: null,
    running: false,
    fastForward: false,
    loadingExample: false,
    runToken: 0,
    loadToken: 0,
    timers: new Set(),
    statusTimers: {
      baseline: null,
      insight: null,
    },
    autoFollow: {
      baseline: true,
      insight: true,
    },
    autoFollowResumeReady: {
      baseline: true,
      insight: true,
    },
    insight: {
      rounds: [],
      activeRoundIndex: -1,
      zoomRounds: 0,
    },
    pdfPages: [],
    pdfThumbsExpanded: false,
    pdfViewerObjectUrl: null,
  };

  const els = {
    exampleSelect: document.getElementById("exampleSelect"),
    btnRun: document.getElementById("btnRun"),
    btnReset: document.getElementById("btnReset"),
    questionText: document.getElementById("questionText"),
    caseMeta: document.getElementById("caseMeta"),
    pdfThumbGrid: document.getElementById("pdfThumbGrid"),
    pdfThumbToggle: document.getElementById("pdfThumbToggle"),
    baselineRes: document.getElementById("baselineRes"),
    insightRes: document.getElementById("insightRes"),
    baselineStatus: document.getElementById("baselineStatus"),
    insightStatus: document.getElementById("insightStatus"),
    baselineStream: document.getElementById("baselineStream"),
    insightStream: document.getElementById("insightStream"),
    pdfViewerModal: document.getElementById("pdfViewerModal"),
    pdfViewerImage: document.getElementById("pdfViewerImage"),
    pdfViewerCaption: document.getElementById("pdfViewerCaption"),
    pdfViewerClose: document.getElementById("pdfViewerClose"),
  };

  function assetUrl(relPath) {
    return `${DATA_BASE}/${String(relPath).replace(/^\/+/, "")}`;
  }

  function dataUrl(relPath) {
    const path = String(relPath).replace(/^\.\//, "");
    return `./${path}`;
  }

  function sleep(ms, token) {
    if (token !== state.runToken || state.fastForward) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = {
        id: null,
        done: false,
        resolve: () => {
          if (timer.done) return;
          timer.done = true;
          clearTimeout(timer.id);
          state.timers.delete(timer);
          resolve();
        },
      };
      timer.id = setTimeout(() => {
        timer.resolve();
      }, Math.max(0, ms));
      state.timers.add(timer);
      if (token !== state.runToken || state.fastForward) {
        timer.resolve();
      }
    });
  }

  function wakeTimers() {
    for (const timer of Array.from(state.timers)) {
      timer.resolve();
    }
  }

  function clearTimers() {
    wakeTimers();
  }

  function fastForwardReplay() {
    if (!state.running) return;
    state.fastForward = true;
    resetAutoFollow();
    wakeTimers();
    updateRunningStatus("baseline");
    updateRunningStatus("insight");
    syncControls();
  }

  function isFastForward(token) {
    return token === state.runToken && state.fastForward;
  }

  function setRunButtonMode() {
    const fastForwarding = state.running;
    els.btnRun.textContent = fastForwarding ? "Skip to end" : "Run comparison";
    els.btnRun.title = fastForwarding ? "Show final replay state instantly" : "";
    els.btnRun.classList.toggle("fast-forward", fastForwarding);
  }

  function setStatus(side, text, cls = "") {
    const el = side === "insight" ? els.insightStatus : els.baselineStatus;
    el.textContent = text;
    el.className = `status ${cls}`.trim();
  }

  function formatSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${n.toFixed(1)}s`;
  }

  function firstTurnStartS(sideData) {
    const firstTurn = sideData?.turns?.[0];
    const startS = Number(firstTurn?.start_s);
    return Number.isFinite(startS) && startS > 0 ? startS : 0;
  }

  function replayDurationS(sideData) {
    const wallTimeS = Number(sideData?.wall_time_s) || 0;
    return Math.max(0, wallTimeS - firstTurnStartS(sideData));
  }

  function replayElapsedSeconds(startedAt, wallTimeS) {
    const elapsed = (performance.now() - startedAt) / 1000;
    const wallTime = Number(wallTimeS);
    if (!Number.isFinite(wallTime) || wallTime <= 0) return elapsed;
    if (state.fastForward) return wallTime;
    return Math.min(elapsed, wallTime);
  }

  function updateRunningStatus(side) {
    const timer = state.statusTimers[side];
    if (!timer || !isActiveToken(timer.token)) return;
    const elapsed = replayElapsedSeconds(timer.startedAt, timer.wallTimeS);
    setStatus(side, `running (${formatSeconds(elapsed)})`, "running");
  }

  function startStatusTimer(side, startedAt, wallTimeS, token) {
    stopStatusTimer(side);
    state.statusTimers[side] = {
      id: setInterval(() => updateRunningStatus(side), 100),
      startedAt,
      wallTimeS,
      token,
    };
    updateRunningStatus(side);
  }

  function stopStatusTimer(side) {
    const timer = state.statusTimers[side];
    if (!timer) return;
    clearInterval(timer.id);
    state.statusTimers[side] = null;
  }

  function stopStatusTimers() {
    stopStatusTimer("baseline");
    stopStatusTimer("insight");
  }

  function setDoneStatus(side, wallTimeS) {
    stopStatusTimer(side);
    setStatus(side, `done (${formatSeconds(wallTimeS)})`, "done");
  }

  function formatCorrectness(value) {
    const score = Number(value);
    if (!Number.isFinite(score)) return { label: "Unknown", className: "unknown" };
    return score >= 0.5
      ? { label: "Correct", className: "correct" }
      : { label: "Wrong", className: "wrong" };
  }

  function formatGroundTruth(value) {
    if (Array.isArray(value)) return value.map(String).join(", ");
    const text = String(value ?? "");
    const match = text.match(/^\[\s*['\"](.*)['\"]\s*\]$/);
    return match ? match[1] : text;
  }

  function formatPredictedAnswer(sideData, finalAnswer) {
    return formatGroundTruth(sideData.extracted_answer || finalAnswer || "—");
  }

  function formatBenchmarkName(value) {
    const key = String(value ?? "");
    if (key.startsWith("mmlongbench")) {
      return key.includes("highpage") ? "MMLongBench-Doc highpage" : "MMLongBench-Doc";
    }
    if (key === "mmlite") return "MME-RealWorld-Lite";
    return key;
  }

  function formatExampleLabel(example) {
    const label = String(example?.label || "");
    if (!label) return formatBenchmarkName(example?.benchmark);
    if (/^MMLongBench highpage\b/.test(label)) {
      return label.replace(/^MMLongBench highpage\b/, "MMLongBench-Doc highpage");
    }
    if (/^MMLongBench(?!-Doc)\b/.test(label)) {
      return label.replace(/^MMLongBench\b/, "MMLongBench-Doc");
    }
    if (/^MMLite\b/.test(label)) {
      return label.replace(/^MMLite\b/, "MME-RealWorld-Lite");
    }
    return label;
  }

  function formatCaseMeta(example) {
    const label = formatExampleLabel(example);
    const benchmark = formatBenchmarkName(example.benchmark);
    const parts = [label || benchmark].filter(Boolean);
    if (
      benchmark &&
      label &&
      !label.toLocaleLowerCase().startsWith(benchmark.toLocaleLowerCase())
    ) {
      parts.push(benchmark);
    }
    parts.push(`${example.page_count} pages`);
    return parts.join(" · ");
  }

  function exampleIdFromUrl() {
    return new URLSearchParams(window.location.search).get("example");
  }

  function resolveExampleId(exampleId) {
    if (!exampleId || !state.manifest?.examples) return null;
    return state.manifest.examples.some((item) => item.id === exampleId) ? exampleId : null;
  }

  function defaultExampleId() {
    return state.manifest?.default_example_id || state.manifest?.examples?.[0]?.id || null;
  }

  function setExampleUrl(exampleId, replace = false) {
    const url = new URL(window.location.href);
    url.searchParams.set("example", exampleId);
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (replace) {
      window.history.replaceState({}, "", nextUrl);
    } else {
      window.history.pushState({}, "", nextUrl);
    }
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\\n/g, "\n");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderPlainMarkdown(el, value) {
    let html = escapeHtml(normalizeText(value));
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\n/g, "<br>");
    el.classList.add("rich-text");
    el.innerHTML = html;
  }

  function streamEl(side) {
    return side === "insight" ? els.insightStream : els.baselineStream;
  }

  function insightActiveHost() {
    const idx = state.insight.activeRoundIndex;
    const round = idx >= 0 ? state.insight.rounds[idx] : null;
    return round?.contentEl || els.insightStream;
  }

  function addEventCard(side, type, title) {
    const card = document.createElement("div");
    card.className = `event-card ${type}`;
    const heading = document.createElement("h4");
    heading.textContent = title;
    const body = document.createElement("div");
    body.className = "event-body";
    card.appendChild(heading);
    card.appendChild(body);
    const host = side === "insight" ? insightActiveHost() : streamEl(side);
    host.appendChild(card);
    scrollSide(side);
    return { card, body };
  }

  function showWaiting(side, message) {
    clearWaiting(side);
    const { card, body } = addEventCard(side, "think", "Running");
    body.textContent = message;
    card.dataset.waiting = "1";
    updateRunningStatus(side);
  }

  function clearWaiting(side) {
    streamEl(side)
      .querySelectorAll('.event-card[data-waiting="1"]')
      .forEach((node) => node.remove());
  }

  function startInsightRound(roundNumber) {
    const idx = roundNumber - 1;
    if (!state.insight.rounds[idx]) {
      state.insight.rounds[idx] = { label: `Turn ${roundNumber}` };
    }
    const round = state.insight.rounds[idx];
    if (!round.el) {
      round.el = document.createElement("div");
      round.el.className = "insight-round-view";
      const title = document.createElement("div");
      title.className = "insight-round-title";
      title.textContent = round.label;
      const content = document.createElement("div");
      content.className = "insight-round-content";
      round.el.appendChild(title);
      round.el.appendChild(content);
      round.contentEl = content;
      els.insightStream.appendChild(round.el);
    }
    state.insight.activeRoundIndex = idx;
    scrollSide("insight");
  }

  function resetStreams() {
    stopStatusTimers();
    resetAutoFollow();
    els.baselineStream.innerHTML = "";
    els.insightStream.innerHTML = "";
    state.insight = { rounds: [], activeRoundIndex: -1, zoomRounds: 0 };
    setStatus("baseline", "idle");
    setStatus("insight", "idle");
  }

  function isActiveToken(token) {
    return token === state.runToken;
  }

  function syncControls() {
    els.btnRun.disabled = state.loadingExample || !state.example;
    setRunButtonMode();
    els.btnReset.disabled =
      !state.running && !els.baselineStream.childElementCount && !els.insightStream.childElementCount;
    // Keep example switching available so users can abort a run by changing cases.
    els.exampleSelect.disabled = state.loadingExample;
  }

  function ensureToolImagesGrid(body) {
    let grid = body.querySelector(".tool-images-grid");
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "tool-images-grid";
      body.appendChild(grid);
    }
    return grid;
  }

  function setImageFrameRatio(frame, size) {
    if (!Array.isArray(size) || size.length !== 2) return;
    const width = Number(size[0]);
    const height = Number(size[1]);
    if (width > 0 && height > 0) {
      frame.style.aspectRatio = `${width} / ${height}`;
    }
  }

  function createImageFrame(className, size) {
    const frame = document.createElement("div");
    frame.className = `${className} is-loading`;
    setImageFrameRatio(frame, size);
    return frame;
  }

  function createToolImageFrame(side, thumbUrl, fullUrl, label, displaySize) {
    const frame = createImageFrame("thumb-image-frame tool-image-frame", displaySize);
    const img = document.createElement("img");
    img.alt = label;
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    img.title = "Open at model-presented size";
    img.decoding = "async";
    img.addEventListener(
      "load",
      () => {
        frame.classList.remove("is-loading");
        frame.classList.add("is-loaded");
        scrollSide(side);
      },
      { once: true }
    );
    img.addEventListener(
      "error",
      () => {
        frame.classList.remove("is-loading");
        frame.classList.add("is-error");
      },
      { once: true }
    );
    img.src = thumbUrl;
    img.addEventListener("click", () => openToolImageViewer(fullUrl, label));
    img.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openToolImageViewer(fullUrl, label);
      }
    });
    frame.appendChild(img);
    return frame;
  }

  function appendToolImages(side, body, items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return;
    const grid = ensureToolImagesGrid(body);
    for (const item of list) {
      if (!item?.thumb_src || !item?.full_src) continue;
      const labelText = item.label || "Tool image";
      const wrap = document.createElement("div");
      wrap.className = `tool-image-item ${item.kind === "bbox" ? "bbox-item" : "crop-item"}`;
      const label = document.createElement("div");
      label.className = "tool-image-label";
      label.textContent = labelText;
      wrap.appendChild(label);
      wrap.appendChild(
        createToolImageFrame(
          side,
          assetUrl(item.thumb_src),
          assetUrl(item.full_src),
          labelText,
          item.display_size
        )
      );
      grid.appendChild(wrap);
    }
    scrollSide(side);
  }

  function scrollSide(side) {
    if (!state.autoFollow[side]) {
      if (!isStreamNearBottom(side)) {
        state.autoFollowResumeReady[side] = true;
      }
      return;
    }
    const el = streamEl(side);
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      if (!state.autoFollow[side]) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  function resetAutoFollow() {
    state.autoFollow.baseline = true;
    state.autoFollow.insight = true;
    state.autoFollowResumeReady.baseline = true;
    state.autoFollowResumeReady.insight = true;
  }

  function isStreamNearBottom(side) {
    const el = streamEl(side);
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX;
  }

  function pauseAutoFollow(side) {
    const el = streamEl(side);
    if (el.scrollHeight <= el.clientHeight + AUTO_FOLLOW_THRESHOLD_PX) return;
    state.autoFollow[side] = false;
    state.autoFollowResumeReady[side] = false;
  }

  function resumeAutoFollowIfNearBottom(side) {
    if (!isStreamNearBottom(side)) return false;
    state.autoFollow[side] = true;
    state.autoFollowResumeReady[side] = true;
    return true;
  }

  function updateAutoFollowFromScroll(side, scrollingForward) {
    const nearBottom = isStreamNearBottom(side);
    if (!nearBottom) {
      state.autoFollow[side] = false;
      state.autoFollowResumeReady[side] = true;
      return;
    }
    if (state.autoFollow[side] || state.autoFollowResumeReady[side] || scrollingForward) {
      state.autoFollow[side] = true;
      state.autoFollowResumeReady[side] = true;
    }
  }

  function isPointerOnVerticalScrollbar(event, el) {
    const scrollbarWidth = el.offsetWidth - el.clientWidth;
    if (scrollbarWidth <= 0) return false;
    const rect = el.getBoundingClientRect();
    return event.clientX >= rect.right - scrollbarWidth;
  }

  function bindStreamAutoFollow(side, el) {
    let lastTouchY = null;
    let lastScrollTop = el.scrollTop;

    el.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY < 0) {
          pauseAutoFollow(side);
        } else if (event.deltaY > 0) {
          state.autoFollowResumeReady[side] = true;
          resumeAutoFollowIfNearBottom(side);
        }
      },
      { passive: true }
    );
    el.addEventListener(
      "touchstart",
      (event) => {
        lastTouchY = event.touches[0]?.clientY ?? null;
      },
      { passive: true }
    );
    el.addEventListener(
      "touchmove",
      (event) => {
        const nextY = event.touches[0]?.clientY ?? null;
        const movingBack = lastTouchY != null && nextY != null && nextY > lastTouchY;
        const movingForward = lastTouchY != null && nextY != null && nextY < lastTouchY;
        if (movingBack) {
          pauseAutoFollow(side);
        } else if (movingForward) {
          state.autoFollowResumeReady[side] = true;
          resumeAutoFollowIfNearBottom(side);
        }
        lastTouchY = nextY;
      },
      { passive: true }
    );
    el.addEventListener(
      "touchend",
      () => {
        lastTouchY = null;
      },
      { passive: true }
    );
    el.addEventListener(
      "touchcancel",
      () => {
        lastTouchY = null;
      },
      { passive: true }
    );
    el.addEventListener("pointerdown", (event) => {
      if (isPointerOnVerticalScrollbar(event, el)) {
        pauseAutoFollow(side);
      }
    });
    el.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      const movingBack = SCROLL_BACK_KEYS.has(event.key) || (event.key === " " && event.shiftKey);
      const movingForward = SCROLL_FORWARD_KEYS.has(event.key) || (event.key === " " && !event.shiftKey);
      if (movingBack) {
        pauseAutoFollow(side);
      } else if (movingForward) {
        state.autoFollowResumeReady[side] = true;
        resumeAutoFollowIfNearBottom(side);
      }
    });
    el.addEventListener("scroll", () => {
      const scrollingForward = el.scrollTop > lastScrollTop;
      updateAutoFollowFromScroll(side, scrollingForward);
      lastScrollTop = el.scrollTop;
    });
  }

  async function streamChunks(side, body, chunks, durationMs, token) {
    const list = Array.isArray(chunks) ? chunks.filter((c) => c != null && c !== "") : [];
    if (!list.length) return "";
    body.classList.remove("rich-text");
    body.textContent = "";

    // Pace against this turn's own clock so we keep the JSON inter-token gaps
    // even if earlier turns/tools made the global wall clock drift late.
    // Using cumulative targets avoids setTimeout drift making later tokens rush.
    const streamStartedAt = performance.now();
    const n = list.length;
    for (let i = 0; i < n; i += 1) {
      if (!isActiveToken(token)) return body.textContent;
      if (isFastForward(token)) {
        body.textContent += list.slice(i).join("");
        scrollSide(side);
        return body.textContent;
      }
      body.textContent += list[i];
      scrollSide(side);
      if (i >= n - 1) break;
      const targetOffsetMs = ((i + 1) / n) * durationMs;
      const elapsedMs = performance.now() - streamStartedAt;
      const remainMs = targetOffsetMs - elapsedMs;
      if (remainMs > 0) {
        await sleep(remainMs, token);
      }
      // If remainMs <= 0 we are behind within this turn (e.g. main-thread stall);
      // emit the next token immediately and let later cumulative targets re-sync.
    }
    return body.textContent;
  }

  async function streamTextAsTokens(side, body, text, durationMs, token) {
    // Fallback only when display_chunks are missing: approximate token-like pieces.
    const content = normalizeText(text);
    if (!content) return "";
    const approx = content.match(/\s+|\S+/g) || [content];
    return streamChunks(side, body, approx, durationMs, token);
  }

  function appendAnswerFooter(side, sideData, zoomRound, finalAnswer, totalTimeS) {
    const { card, body } = addEventCard(side, "summary", "Summary");
    const gt = formatGroundTruth(state.example?.ground_truth || "—");
    const predicted = formatPredictedAnswer(sideData, finalAnswer);
    const correctness = formatCorrectness(sideData.accuracy);
    const lines = [
      `<div><strong>Ground truth:</strong> ${escapeHtml(gt)}</div>`,
      `<div><strong>Predicted answer:</strong> ${escapeHtml(predicted)} <span class="answer-result ${correctness.className}">${correctness.label}</span></div>`,
      `<div><strong>Total generation time:</strong> ${escapeHtml(formatSeconds(totalTimeS))}</div>`,
    ];
    if (sideData.side === "rl" || zoomRound > 0) {
      lines.push(`<div><strong>Tool turns:</strong> ${zoomRound}</div>`);
    }
    body.classList.add("rich-text");
    body.innerHTML = lines.join("");
    scrollSide(side);
    return card;
  }

  async function waitUntil(elapsedTargetS, startedAt, token) {
    while (token === state.runToken) {
      if (isFastForward(token)) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      const remain = elapsedTargetS - elapsed;
      if (remain <= 0) return;
      await sleep(Math.min(40, remain * 1000), token);
    }
  }

  async function replaySide(side, sideData, token, startedAt) {
    const isInsight = side === "insight";
    const timelineOffsetS = firstTurnStartS(sideData);
    const totalTimeS = replayDurationS(sideData);
    const replayTimeS = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, n - timelineOffsetS);
    };
    startStatusTimer(side, startedAt, totalTimeS, token);

    const turns = sideData.turns || [];
    let zoomRound = 0;
    let finalAnswer = sideData.extracted_answer || "";
    let lastAnswerCard = null;

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (!isActiveToken(token)) return;
      const turn = turns[turnIndex];

      await waitUntil(replayTimeS(turn.start_s), startedAt, token);
      if (!isActiveToken(token)) return;

      if (isInsight) {
        if (turn.type === "tool_call") {
          zoomRound += 1;
          state.insight.zoomRounds = zoomRound;
          startInsightRound(zoomRound);
        } else if (turn.type === "answer" || turn.type === "answer_revision") {
          startInsightRound(Math.max(1, zoomRound + 1));
        } else {
          startInsightRound(Math.max(1, turnIndex + 1));
        }
      }

      // Hold / re-show Prefilling in this turn's host until its first decode token.
      showWaiting(side, "Prefilling… waiting for decoding to start");
      updateRunningStatus(side);

      const ttft = Math.max(0, Number(turn.time_to_first_token_s) || 0);
      const duration = Math.max(0, Number(turn.duration_s) || 0);
      // Stay in Prefilling through TTFT; only then start emitting tokens.
      await waitUntil(replayTimeS(turn.start_s) + ttft, startedAt, token);
      if (!isActiveToken(token)) return;

      clearWaiting(side);

      const streamBudgetMs = Math.max(0, (duration - ttft) * 1000);
      const responseChunks = turn.display_chunks || [];

      if (turn.type === "tool_call") {
        // Stream the full assistant response tokens, including raw <tool_call> markup.
        const responseCard = addEventCard(side, "think", "Response");
        if (responseChunks.length) {
          await streamChunks(side, responseCard.body, responseChunks, streamBudgetMs, token);
        } else {
          const fallback = [turn.think || "", turn.tool_call ? `\n<tool_call>\n${JSON.stringify(turn.tool_call)}\n</tool_call>` : ""]
            .join("")
            .trim();
          await streamTextAsTokens(side, responseCard.body, fallback, streamBudgetMs, token);
        }
        if (!isActiveToken(token)) return;

        // After generation finishes, wait for the recorded tool window before visuals.
        const tool = turn.tool_call || {};
        const args = tool.arguments || {};
        const traces = turn.tool_call_traces || [];
        const trace = traces[0] || null;

        if (trace) {
          await waitUntil(replayTimeS(trace.start_s || turn.end_s || 0), startedAt, token);
        } else {
          await waitUntil(replayTimeS(turn.end_s), startedAt, token);
        }
        if (!isActiveToken(token)) return;

        const toolCard = addEventCard(side, "tool", `Tool Call · Turn ${zoomRound}`);
        const meta = document.createElement("div");
        meta.className = "event-meta";
        meta.textContent = [
          tool.name || "image_zoom_in_tool",
          typeof args.img_idx === "number" ? `img ${args.img_idx}` : null,
          args.label ? `"${args.label}"` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        toolCard.body.appendChild(meta);

        const toolVisuals = Array.isArray(turn.tool_visuals) ? turn.tool_visuals : [];
        appendToolImages(
          side,
          toolCard.body,
          toolVisuals.filter((item) => item.kind === "bbox")
        );

        if (trace) {
          await waitUntil(replayTimeS(trace.end_s || turn.end_s || 0), startedAt, token);
        }
        if (!isActiveToken(token)) return;

        appendToolImages(
          side,
          toolCard.body,
          toolVisuals.filter((item) => item.kind === "crop")
        );
      } else {
        const answerCard = addEventCard(side, "answer", "Response");
        lastAnswerCard = answerCard;
        let streamed = "";
        if (responseChunks.length) {
          streamed = await streamChunks(
            side,
            answerCard.body,
            responseChunks,
            streamBudgetMs,
            token
          );
        } else {
          streamed = await streamTextAsTokens(
            side,
            answerCard.body,
            turn.answer || finalAnswer,
            streamBudgetMs,
            token
          );
        }
        if (!isActiveToken(token)) return;
        const raw = streamed || turn.answer || finalAnswer || "";
        if (raw.trim()) {
          finalAnswer = raw.trim();
          renderPlainMarkdown(answerCard.body, raw);
        }
        await waitUntil(replayTimeS(turn.end_s), startedAt, token);
        if (!isActiveToken(token)) return;
      }
    }

    await waitUntil(totalTimeS, startedAt, token);
    if (!isActiveToken(token)) return;
    clearWaiting(side);
    setDoneStatus(side, totalTimeS);

    if (!lastAnswerCard) {
      lastAnswerCard = addEventCard(side, "answer", "Response");
      renderPlainMarkdown(
        lastAnswerCard.body,
        finalAnswer || sideData.extracted_answer || "—"
      );
    }
    appendAnswerFooter(side, sideData, zoomRound, finalAnswer, totalTimeS);
    return {
      wallTime: totalTimeS,
      answer: finalAnswer || sideData.extracted_answer || "",
      zoomRounds: zoomRound,
    };
  }

  async function runComparison() {
    if (!state.example || state.loadingExample) return;
    if (state.running) {
      fastForwardReplay();
      return;
    }
    const example = state.example;
    const exampleId = state.exampleId;
    state.running = true;
    state.fastForward = false;
    state.runToken += 1;
    const token = state.runToken;
    clearTimers();
    resetStreams();
    syncControls();

    const startedAt = performance.now();
    try {
      await Promise.all([
        replaySide("baseline", example.baseline, token, startedAt),
        replaySide("insight", example.insight, token, startedAt),
      ]);
    } catch (err) {
      if (isActiveToken(token)) {
        stopStatusTimers();
        setStatus("baseline", "error", "error");
        setStatus("insight", "error", "error");
        const { body } = addEventCard("baseline", "think", "Error");
        body.textContent = err.message || String(err);
      }
    } finally {
      if (isActiveToken(token)) {
        state.running = false;
        state.fastForward = false;
        // If the example changed mid-run, discard any leftover stream from the old case.
        if (state.exampleId !== exampleId) {
          resetStreams();
        }
        syncControls();
      }
    }
  }

  function stopAndReset() {
    state.runToken += 1;
    state.running = false;
    state.fastForward = false;
    clearTimers();
    resetStreams();
    syncControls();
  }

  function collapsedThumbLimit() {
    if (window.matchMedia("(max-width: 800px)").matches) return 10;
    if (window.matchMedia("(max-width: 1100px)").matches) return 16;
    return 24;
  }

  function setPdfThumbsExpanded(expanded) {
    state.pdfThumbsExpanded = expanded;
    renderPdfThumbGrid();
  }

  function updatePdfThumbToggle() {
    const canExpand = state.pdfPages.length > collapsedThumbLimit();
    els.pdfThumbToggle.hidden = !canExpand;
    if (!canExpand) {
      state.pdfThumbsExpanded = false;
      els.pdfThumbToggle.classList.remove("is-expanded");
      els.pdfThumbToggle.setAttribute("aria-expanded", "false");
      return;
    }
    els.pdfThumbToggle.textContent = state.pdfThumbsExpanded
      ? "Show fewer pages"
      : `Show all ${state.pdfPages.length} pages`;
    els.pdfThumbToggle.classList.toggle("is-expanded", state.pdfThumbsExpanded);
    els.pdfThumbToggle.setAttribute("aria-expanded", String(state.pdfThumbsExpanded));
  }

  function createPdfThumb(page, idx) {
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "pdf-thumb";
    thumb.title = `Page ${idx}`;
    const frame = createImageFrame("thumb-image-frame pdf-thumb-image-frame", page.original_size);
    const img = document.createElement("img");
    img.alt = `Page ${idx}`;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener(
      "load",
      () => {
        frame.classList.remove("is-loading");
        frame.classList.add("is-loaded");
      },
      { once: true }
    );
    img.addEventListener(
      "error",
      () => {
        frame.classList.remove("is-loading");
        frame.classList.add("is-error");
      },
      { once: true }
    );
    img.src = assetUrl(page.thumb || page.src);
    const label = document.createElement("div");
    label.className = "pdf-thumb-label";
    label.textContent = `P${idx}`;
    frame.appendChild(img);
    thumb.appendChild(frame);
    thumb.appendChild(label);
    thumb.addEventListener("click", () => openPdfViewer(page, idx));
    return thumb;
  }

  function renderPdfThumbGrid() {
    els.pdfThumbGrid.innerHTML = "";
    if (!state.pdfPages.length) {
      els.pdfThumbGrid.textContent = "No pages available.";
      els.pdfThumbToggle.hidden = true;
      return;
    }
    const visibleCount = state.pdfThumbsExpanded
      ? state.pdfPages.length
      : Math.min(state.pdfPages.length, collapsedThumbLimit());
    const fragment = document.createDocumentFragment();
    for (let idx = 0; idx < visibleCount; idx += 1) {
      fragment.appendChild(createPdfThumb(state.pdfPages[idx], idx));
    }
    els.pdfThumbGrid.appendChild(fragment);
    updatePdfThumbToggle();
  }

  function renderPdfThumbnails(example) {
    state.pdfPages = example?.insight?.pages || [];
    state.pdfThumbsExpanded = false;
    els.pdfThumbToggle.hidden = true;
    renderPdfThumbGrid();
  }

  function closePdfViewer() {
    els.pdfViewerModal.hidden = true;
    delete els.pdfViewerModal.dataset.viewer;
    els.pdfViewerImage.src = "";
    els.pdfViewerImage.alt = "Original PDF page";
    if (state.pdfViewerObjectUrl) {
      URL.revokeObjectURL(state.pdfViewerObjectUrl);
      state.pdfViewerObjectUrl = null;
    }
  }

  function openPdfViewer(page, pageIdx) {
    closePdfViewer();
    els.pdfViewerModal.dataset.viewer = "pdf";
    els.pdfViewerCaption.textContent = `Loading page ${pageIdx}…`;
    els.pdfViewerModal.hidden = false;
    const url = assetUrl(page.src);
    els.pdfViewerImage.alt = `Original PDF page ${pageIdx}`;
    els.pdfViewerImage.src = url;
    els.pdfViewerImage.onload = () => {
      els.pdfViewerCaption.textContent = `Page ${pageIdx} (original resolution)`;
    };
    els.pdfViewerImage.onerror = () => {
      els.pdfViewerCaption.textContent = `Page ${pageIdx} failed to load.`;
    };
  }

  function openToolImageViewer(url, label) {
    closePdfViewer();
    els.pdfViewerModal.dataset.viewer = "tool";
    els.pdfViewerCaption.textContent = `${label} · loading model-presented size…`;
    els.pdfViewerModal.hidden = false;
    els.pdfViewerImage.alt = label;
    els.pdfViewerImage.src = url;
    els.pdfViewerImage.onload = () => {
      const width = els.pdfViewerImage.naturalWidth;
      const height = els.pdfViewerImage.naturalHeight;
      const size = width && height ? ` · ${width} × ${height}px` : "";
      els.pdfViewerCaption.textContent = `${label}${size} · model-presented size`;
    };
    els.pdfViewerImage.onerror = () => {
      els.pdfViewerCaption.textContent = `${label} failed to load.`;
    };
  }

  function populateExampleSelect(manifest) {
    els.exampleSelect.innerHTML = "";
    for (const item of manifest.examples || []) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${formatExampleLabel(item)} (${item.page_count}p)`;
      els.exampleSelect.appendChild(option);
    }
  }

  async function loadExample(exampleId, options = {}) {
    state.loadToken += 1;
    const loadToken = state.loadToken;
    state.loadingExample = true;
    stopAndReset();
    syncControls();
    state.pdfPages = [];
    state.pdfThumbsExpanded = false;
    els.questionText.textContent = "Loading example…";
    els.pdfThumbGrid.textContent = "Loading pages…";
    els.pdfThumbToggle.hidden = true;
    const meta = (state.manifest.examples || []).find((item) => item.id === exampleId);
    const path = meta?.path || `data/examples/${exampleId}.json`;
    try {
      const res = await fetch(dataUrl(path), { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load example (${res.status})`);
      const example = await res.json();
      // A newer example selection superseded this fetch.
      if (loadToken !== state.loadToken) return;
      state.example = example;
      state.exampleId = example.id;
      els.exampleSelect.value = example.id;
      if (options.updateUrl) {
        setExampleUrl(example.id, Boolean(options.replaceUrl));
      }
      // Clear again in case a stale run wrote into the streams during fetch.
      resetStreams();
      renderPlainMarkdown(els.questionText, example.question || "");
      els.caseMeta.textContent = formatCaseMeta(example);
      els.baselineRes.textContent = `r=${Number(example.baseline?.initial_rescale ?? 0.7)}`;
      els.insightRes.textContent = `r=${Number(example.insight?.initial_rescale ?? 0.35)}`;
      renderPdfThumbnails(example);
    } finally {
      if (loadToken === state.loadToken) {
        state.loadingExample = false;
        syncControls();
      }
    }
  }

  async function init() {
    state.loadingExample = true;
    syncControls();
    const res = await fetch(dataUrl(`${DATA_BASE}/examples.json`), { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load examples.json (${res.status})`);
    state.manifest = await res.json();
    populateExampleSelect(state.manifest);
    const requestedId = exampleIdFromUrl();
    const initialId = resolveExampleId(requestedId) || defaultExampleId();
    await loadExample(initialId, {
      updateUrl: Boolean(requestedId),
      replaceUrl: true,
    });
  }

  els.btnRun.addEventListener("click", () => {
    if (state.running) {
      fastForwardReplay();
    } else {
      runComparison();
    }
  });
  els.btnReset.addEventListener("click", () => {
    stopAndReset();
  });
  els.pdfThumbToggle.addEventListener("click", () => {
    setPdfThumbsExpanded(!state.pdfThumbsExpanded);
  });
  bindStreamAutoFollow("baseline", els.baselineStream);
  bindStreamAutoFollow("insight", els.insightStream);
  window.addEventListener("resize", () => {
    if (!state.loadingExample) renderPdfThumbGrid();
  });
  window.addEventListener("popstate", async () => {
    if (!state.manifest) return;
    const nextId = resolveExampleId(exampleIdFromUrl()) || defaultExampleId();
    if (nextId && nextId !== state.exampleId) {
      await loadExample(nextId, { updateUrl: false });
    }
  });
  els.exampleSelect.addEventListener("change", async () => {
    try {
      await loadExample(els.exampleSelect.value, { updateUrl: true });
    } catch (err) {
      els.questionText.textContent = `Failed to load example: ${err.message}`;
    }
  });
  els.pdfViewerClose.addEventListener("click", closePdfViewer);
  els.pdfViewerModal.addEventListener("click", (event) => {
    if (event.target === els.pdfViewerModal) closePdfViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePdfViewer();
  });

  init().catch((err) => {
    els.questionText.textContent = `Failed to initialize demo: ${err.message}`;
    els.pdfThumbGrid.textContent = "Unavailable";
  });
})();
