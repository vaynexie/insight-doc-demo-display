(() => {
  "use strict";

  const DATA_BASE = "./data";
  const DATA_VERSION = "20260806-6";
  const IMAGE_CACHE = new Map();

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
    insight: {
      rounds: [],
      activeRoundIndex: -1,
      zoomRounds: 0,
    },
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
    const sep = path.includes("?") ? "&" : "?";
    return `./${path}${sep}v=${DATA_VERSION}`;
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
    wakeTimers();
    syncControls();
  }

  function isFastForward(token) {
    return token === state.runToken && state.fastForward;
  }

  function setRunButtonMode() {
    const fastForwarding = state.running;
    els.btnRun.textContent = fastForwarding ? "Fast-forward" : "Run comparison";
    els.btnRun.title = fastForwarding ? "Finish this replay instantly" : "";
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
    return `${n.toFixed(2)}s`;
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
    streamEl(side).scrollTop = streamEl(side).scrollHeight;
    return { card, body };
  }

  function showWaiting(side, message) {
    clearWaiting(side);
    const { card, body } = addEventCard(side, "think", "Running");
    body.textContent = message;
    card.dataset.waiting = "1";
    setStatus(side, "running", "running");
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
    els.insightStream.scrollTop = els.insightStream.scrollHeight;
  }

  function resetStreams() {
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

  function loadImage(url) {
    if (IMAGE_CACHE.has(url)) return IMAGE_CACHE.get(url);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${url}`));
      img.src = url;
    });
    IMAGE_CACHE.set(url, promise);
    return promise;
  }

  function presentedByIdx(sideData, presentedIdx) {
    return (sideData.presented_images || []).find(
      (ref) => ref.presented_img_idx === presentedIdx
    );
  }

  function pageByOriginalIdx(sideData, originalIdx) {
    return (sideData.pages || []).find((page) => page.original_img_idx === originalIdx);
  }

  function pageSrc(sideData, originalIdx) {
    const page = pageByOriginalIdx(sideData, originalIdx);
    return page ? assetUrl(page.src) : null;
  }

  async function renderPresentedImage(sideData, presentedIdx) {
    const presented = presentedByIdx(sideData, presentedIdx);
    if (!presented) return null;
    const sourceIdx = presented.source_original_img_idx;
    const src = pageSrc(sideData, sourceIdx);
    if (!src) return null;
    const img = await loadImage(src);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const bbox = presented.bbox_on_original;
    let sx = 0;
    let sy = 0;
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    if (Array.isArray(bbox) && bbox.length === 4) {
      const x1 = Math.max(0, Math.min(img.naturalWidth, Math.round(bbox[0])));
      const y1 = Math.max(0, Math.min(img.naturalHeight, Math.round(bbox[1])));
      const x2 = Math.max(0, Math.min(img.naturalWidth, Math.round(bbox[2])));
      const y2 = Math.max(0, Math.min(img.naturalHeight, Math.round(bbox[3])));
      sx = Math.min(x1, x2);
      sy = Math.min(y1, y2);
      sw = Math.max(1, Math.abs(x2 - x1));
      sh = Math.max(1, Math.abs(y2 - y1));
    }
    let dw = sw;
    let dh = sh;
    if (Array.isArray(presented.display_size) && presented.display_size.length === 2) {
      dw = Math.max(1, Math.round(presented.display_size[0]));
      dh = Math.max(1, Math.round(presented.display_size[1]));
    }
    canvas.width = dw;
    canvas.height = dh;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    return canvas.toDataURL("image/jpeg", 0.88);
  }

  function projectBbox(bbox2d, presented, canvasWidth, canvasHeight) {
    let x1 = Number(bbox2d[0]);
    let y1 = Number(bbox2d[1]);
    let x2 = Number(bbox2d[2]);
    let y2 = Number(bbox2d[3]);
    let bboxMaxX = Math.max(x1, x2);
    let bboxMaxY = Math.max(y1, y2);
    const displaySize = presented.display_size;
    const originalSize = presented.original_size;

    if (
      Array.isArray(displaySize) &&
      displaySize.length === 2 &&
      Math.min(x1, y1, x2, y2) >= 0 &&
      bboxMaxX <= 1000 &&
      bboxMaxY <= 1000
    ) {
      const dw = Number(displaySize[0]);
      const dh = Number(displaySize[1]);
      if (dw > 0 && dh > 0) {
        x1 = (x1 * dw) / 1000;
        x2 = (x2 * dw) / 1000;
        y1 = (y1 * dh) / 1000;
        y2 = (y2 * dh) / 1000;
        bboxMaxX = Math.max(x1, x2);
        bboxMaxY = Math.max(y1, y2);
      }
    }

    if (
      Array.isArray(originalSize) &&
      originalSize.length === 2 &&
      Array.isArray(displaySize) &&
      displaySize.length === 2
    ) {
      const ow = Number(originalSize[0]);
      const oh = Number(originalSize[1]);
      const dw = Number(displaySize[0]);
      const dh = Number(displaySize[1]);
      const likelyOriginal =
        ow > 0 &&
        oh > 0 &&
        (bboxMaxX > dw || bboxMaxY > dh) &&
        bboxMaxX <= ow &&
        bboxMaxY <= oh;
      if (likelyOriginal) {
        x1 = (x1 * dw) / ow;
        x2 = (x2 * dw) / ow;
        y1 = (y1 * dh) / oh;
        y2 = (y2 * dh) / oh;
      }
    }

    if (Array.isArray(displaySize) && displaySize.length === 2) {
      const dw = Number(displaySize[0]);
      const dh = Number(displaySize[1]);
      if (dw > 0 && dh > 0 && (dw !== canvasWidth || dh !== canvasHeight)) {
        x1 = (x1 * canvasWidth) / dw;
        x2 = (x2 * canvasWidth) / dw;
        y1 = (y1 * canvasHeight) / dh;
        y2 = (y2 * canvasHeight) / dh;
      }
    }

    x1 = Math.max(0, Math.min(canvasWidth - 1, Math.round(x1)));
    x2 = Math.max(0, Math.min(canvasWidth - 1, Math.round(x2)));
    y1 = Math.max(0, Math.min(canvasHeight - 1, Math.round(y1)));
    y2 = Math.max(0, Math.min(canvasHeight - 1, Math.round(y2)));
    if (x1 === x2) x2 = Math.min(canvasWidth - 1, x1 + 1);
    if (y1 === y2) y2 = Math.min(canvasHeight - 1, y1 + 1);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }

  async function renderBboxOverlay(sideData, imgIdx, bbox2d) {
    const presented = presentedByIdx(sideData, imgIdx);
    if (!presented || !Array.isArray(bbox2d) || bbox2d.length !== 4) return null;
    const baseUrl = await renderPresentedImage(sideData, imgIdx);
    if (!baseUrl) return null;
    const img = await loadImage(baseUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const [x1, y1, x2, y2] = projectBbox(bbox2d, presented, canvas.width, canvas.height);
    ctx.strokeStyle = "rgb(255, 80, 60)";
    ctx.lineWidth = Math.max(6, Math.round(Math.min(canvas.width, canvas.height) / 90));
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    return canvas.toDataURL("image/jpeg", 0.88);
  }

  function appendToolImages(body, items) {
    let grid = body.querySelector(".tool-images-grid");
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "tool-images-grid";
      body.appendChild(grid);
    }
    for (const item of items) {
      if (!item?.url) continue;
      const wrap = document.createElement("div");
      wrap.className = `tool-image-item ${item.kind === "bbox" ? "bbox-item" : "crop-item"}`;
      const label = document.createElement("div");
      label.className = "tool-image-label";
      label.textContent = item.label;
      const img = document.createElement("img");
      img.src = item.url;
      img.alt = item.label;
      wrap.appendChild(label);
      wrap.appendChild(img);
      grid.appendChild(wrap);
    }
    els.insightStream.scrollTop = els.insightStream.scrollHeight;
  }

  function scrollSide(side) {
    streamEl(side).scrollTop = streamEl(side).scrollHeight;
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

  function appendAnswerFooter(side, sideData, zoomRound, finalAnswer) {
    const { card, body } = addEventCard(side, "summary", "Summary");
    const gt = formatGroundTruth(state.example?.ground_truth || "—");
    const predicted = formatPredictedAnswer(sideData, finalAnswer);
    const correctness = formatCorrectness(sideData.accuracy);
    const lines = [
      `<div><strong>Ground truth:</strong> ${escapeHtml(gt)}</div>`,
      `<div><strong>Predicted answer:</strong> ${escapeHtml(predicted)} <span class="answer-result ${correctness.className}">${correctness.label}</span></div>`,
      `<div><strong>Total generation time:</strong> ${escapeHtml(formatSeconds(sideData.wall_time_s))}</div>`,
    ];
    if (sideData.side === "rl" || zoomRound > 0) {
      lines.push(`<div><strong>Tool turns:</strong> ${zoomRound}</div>`);
    }
    body.classList.add("rich-text");
    body.innerHTML = lines.join("");
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
    showWaiting(side, "Prefilling… waiting for decoding to start");

    const turns = sideData.turns || [];
    let zoomRound = 0;
    let finalAnswer = sideData.extracted_answer || "";
    let lastAnswerCard = null;

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (!isActiveToken(token)) return;
      const turn = turns[turnIndex];

      // Hold / re-show Prefilling until this turn's first decode token.
      showWaiting(side, "Prefilling… waiting for decoding to start");
      setStatus(side, "running", "running");

      await waitUntil(turn.start_s || 0, startedAt, token);
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

      const ttft = Math.max(0, Number(turn.time_to_first_token_s) || 0);
      const duration = Math.max(0, Number(turn.duration_s) || 0);
      // Stay in Prefilling through TTFT; only then start emitting tokens.
      await waitUntil((turn.start_s || 0) + ttft, startedAt, token);
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
        const cropIdxs = turn.crop_presented_indices || [];

        if (trace) {
          await waitUntil(trace.start_s || turn.end_s || 0, startedAt, token);
        } else {
          await waitUntil(turn.end_s || 0, startedAt, token);
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

        if (Array.isArray(args.bbox_2d) && typeof args.img_idx === "number") {
          try {
            const overlay = await renderBboxOverlay(sideData, args.img_idx, args.bbox_2d);
            if (!isActiveToken(token)) return;
            appendToolImages(toolCard.body, [{ label: "BBox overlay", url: overlay, kind: "bbox" }]);
          } catch (err) {
            if (!isActiveToken(token)) return;
            const note = document.createElement("div");
            note.className = "event-meta";
            note.textContent = `BBox overlay unavailable (${err.message})`;
            toolCard.body.appendChild(note);
          }
        }

        if (trace) {
          await waitUntil(trace.end_s || turn.end_s || 0, startedAt, token);
        }
        if (!isActiveToken(token)) return;

        for (const cropIdx of cropIdxs) {
          try {
            const cropUrl = await renderPresentedImage(sideData, cropIdx);
            if (!isActiveToken(token)) return;
            appendToolImages(toolCard.body, [
              { label: `Crop · image ${cropIdx}`, url: cropUrl, kind: "crop" },
            ]);
          } catch (err) {
            if (!isActiveToken(token)) return;
            const note = document.createElement("div");
            note.className = "event-meta";
            note.textContent = `Crop ${cropIdx} unavailable (${err.message})`;
            toolCard.body.appendChild(note);
          }
        }
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
        await waitUntil(turn.end_s || 0, startedAt, token);
        if (!isActiveToken(token)) return;
      }
    }

    await waitUntil(sideData.wall_time_s || 0, startedAt, token);
    if (!isActiveToken(token)) return;
    clearWaiting(side);
    setStatus(side, "done", "done");

    if (!lastAnswerCard) {
      lastAnswerCard = addEventCard(side, "answer", "Response");
      renderPlainMarkdown(
        lastAnswerCard.body,
        finalAnswer || sideData.extracted_answer || "—"
      );
    }
    appendAnswerFooter(side, sideData, zoomRound, finalAnswer);
    return {
      wallTime: sideData.wall_time_s,
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
    els.pdfThumbGrid.classList.toggle("collapsed", !expanded);
    els.pdfThumbToggle.textContent = expanded ? "Show fewer pages" : "Show all pages";
    els.pdfThumbToggle.classList.toggle("is-expanded", expanded);
    els.pdfThumbToggle.setAttribute("aria-expanded", String(expanded));
  }

  function updatePdfThumbToggle() {
    const pageCount = els.pdfThumbGrid.querySelectorAll(".pdf-thumb").length;
    const canExpand = pageCount > collapsedThumbLimit();
    els.pdfThumbToggle.hidden = !canExpand;
    if (!canExpand) {
      els.pdfThumbGrid.classList.remove("collapsed");
      els.pdfThumbToggle.classList.remove("is-expanded");
      els.pdfThumbToggle.setAttribute("aria-expanded", "false");
      return;
    }
    setPdfThumbsExpanded(state.pdfThumbsExpanded);
  }

  function renderPdfThumbnails(example) {
    const pages = example?.insight?.pages || [];
    els.pdfThumbGrid.innerHTML = "";
    state.pdfThumbsExpanded = false;
    els.pdfThumbToggle.hidden = true;
    if (!pages.length) {
      els.pdfThumbGrid.textContent = "No pages available.";
      return;
    }
    pages.forEach((page, idx) => {
      const thumb = document.createElement("button");
      thumb.type = "button";
      thumb.className = "pdf-thumb";
      thumb.title = `Page ${idx}`;
      const img = document.createElement("img");
      img.alt = `Page ${idx}`;
      img.loading = "lazy";
      img.src = assetUrl(page.thumb || page.src);
      const label = document.createElement("div");
      label.className = "pdf-thumb-label";
      label.textContent = `P${idx}`;
      thumb.appendChild(img);
      thumb.appendChild(label);
      thumb.addEventListener("click", () => openPdfViewer(page, idx));
      els.pdfThumbGrid.appendChild(thumb);
    });
    updatePdfThumbToggle();
  }

  function closePdfViewer() {
    els.pdfViewerModal.hidden = true;
    els.pdfViewerImage.src = "";
    if (state.pdfViewerObjectUrl) {
      URL.revokeObjectURL(state.pdfViewerObjectUrl);
      state.pdfViewerObjectUrl = null;
    }
  }

  function openPdfViewer(page, pageIdx) {
    closePdfViewer();
    els.pdfViewerCaption.textContent = `Loading page ${pageIdx}…`;
    els.pdfViewerModal.hidden = false;
    const url = assetUrl(page.src);
    els.pdfViewerImage.src = url;
    els.pdfViewerImage.onload = () => {
      els.pdfViewerCaption.textContent = `Page ${pageIdx} (original resolution)`;
    };
    els.pdfViewerImage.onerror = () => {
      els.pdfViewerCaption.textContent = `Page ${pageIdx} failed to load.`;
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

  async function loadExample(exampleId) {
    state.loadToken += 1;
    const loadToken = state.loadToken;
    state.loadingExample = true;
    stopAndReset();
    syncControls();
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
    const initialId = state.manifest.default_example_id || state.manifest.examples?.[0]?.id;
    await loadExample(initialId);
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
  window.addEventListener("resize", updatePdfThumbToggle);
  els.exampleSelect.addEventListener("change", async () => {
    try {
      await loadExample(els.exampleSelect.value);
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
