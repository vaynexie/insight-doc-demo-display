(() => {
  "use strict";

  const DATA_BASE = "./data";
  const IMAGE_CACHE = new Map();

  const state = {
    manifest: null,
    example: null,
    exampleId: null,
    running: false,
    runToken: 0,
    timers: new Set(),
    insight: {
      rounds: [],
      activeRoundIndex: -1,
      zoomRounds: 0,
    },
    pdfViewerObjectUrl: null,
  };

  const els = {
    exampleSelect: document.getElementById("exampleSelect"),
    btnRun: document.getElementById("btnRun"),
    btnReset: document.getElementById("btnReset"),
    questionText: document.getElementById("questionText"),
    caseMeta: document.getElementById("caseMeta"),
    pdfThumbGrid: document.getElementById("pdfThumbGrid"),
    baselineRes: document.getElementById("baselineRes"),
    insightRes: document.getElementById("insightRes"),
    baselineStatus: document.getElementById("baselineStatus"),
    insightStatus: document.getElementById("insightStatus"),
    baselineStream: document.getElementById("baselineStream"),
    insightStream: document.getElementById("insightStream"),
    comparisonCard: document.getElementById("comparisonCard"),
    metricBaselineTime: document.getElementById("metricBaselineTime"),
    metricInsightTime: document.getElementById("metricInsightTime"),
    metricZoomRounds: document.getElementById("metricZoomRounds"),
    metricBaselineAnswer: document.getElementById("metricBaselineAnswer"),
    metricInsightAnswer: document.getElementById("metricInsightAnswer"),
    metricGroundTruth: document.getElementById("metricGroundTruth"),
    pdfViewerModal: document.getElementById("pdfViewerModal"),
    pdfViewerImage: document.getElementById("pdfViewerImage"),
    pdfViewerCaption: document.getElementById("pdfViewerCaption"),
    pdfViewerClose: document.getElementById("pdfViewerClose"),
  };

  function assetUrl(relPath) {
    return `${DATA_BASE}/${String(relPath).replace(/^\/+/, "")}`;
  }

  function sleep(ms, token) {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        state.timers.delete(id);
        resolve();
      }, ms);
      state.timers.add(id);
      if (token !== state.runToken) {
        clearTimeout(id);
        state.timers.delete(id);
        resolve();
      }
    });
  }

  function clearTimers() {
    for (const id of state.timers) clearTimeout(id);
    state.timers.clear();
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

  function formatGroundTruth(value) {
    if (Array.isArray(value)) return value.map(String).join(", ");
    const text = String(value ?? "");
    const match = text.match(/^\[\s*['\"](.*)['\"]\s*\]$/);
    return match ? match[1] : text;
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
    const { card, body } = addEventCard(side, "think", "Waiting");
    body.textContent = message;
    card.dataset.waiting = "1";
    setStatus(side, "waiting", "waiting");
  }

  function clearWaiting(side) {
    streamEl(side)
      .querySelectorAll('.event-card[data-waiting="1"]')
      .forEach((node) => node.remove());
  }

  function startInsightRound(roundNumber) {
    const idx = roundNumber - 1;
    if (!state.insight.rounds[idx]) {
      state.insight.rounds[idx] = { label: `Run ${roundNumber}` };
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
    els.comparisonCard.hidden = true;
    els.metricBaselineTime.textContent = "—";
    els.metricInsightTime.textContent = "—";
    els.metricZoomRounds.textContent = "0";
    els.metricBaselineAnswer.textContent = "";
    els.metricInsightAnswer.textContent = "";
    els.metricGroundTruth.textContent = "—";
    setStatus("baseline", "idle");
    setStatus("insight", "idle");
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
    ctx.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 180));
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
      wrap.className = "tool-image-item";
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

  async function streamText(side, body, text, durationMs, token) {
    const content = String(text || "");
    if (!content) return;
    if (durationMs <= 0 || content.length <= 1) {
      body.textContent = content;
      scrollSide(side);
      return;
    }
    const chunkSize = Math.max(
      1,
      Math.ceil(content.length / Math.max(1, Math.floor(durationMs / 28)))
    );
    const chunks = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize));
    }
    const step = durationMs / chunks.length;
    body.textContent = "";
    for (const chunk of chunks) {
      if (token !== state.runToken) return;
      body.textContent += chunk;
      scrollSide(side);
      await sleep(step, token);
    }
  }

  async function streamChunks(side, body, chunks, durationMs, token) {
    const list = Array.isArray(chunks) ? chunks.filter((c) => c != null && c !== "") : [];
    if (!list.length) return;
    if (durationMs <= 0 || list.length === 1) {
      body.textContent = list.join("");
      scrollSide(side);
      return;
    }
    const step = durationMs / list.length;
    body.textContent = "";
    for (const chunk of list) {
      if (token !== state.runToken) return;
      body.textContent += chunk;
      scrollSide(side);
      await sleep(step, token);
    }
  }

  function chunksBeforeToolCall(chunks) {
    const list = Array.isArray(chunks) ? chunks : [];
    const out = [];
    let joined = "";
    for (const chunk of list) {
      joined += chunk;
      if (joined.includes("<tool_call>")) break;
      out.push(chunk);
    }
    return out;
  }

  async function waitUntil(elapsedTargetS, startedAt, token) {
    while (token === state.runToken) {
      const elapsed = (performance.now() - startedAt) / 1000;
      const remain = elapsedTargetS - elapsed;
      if (remain <= 0) return;
      await sleep(Math.min(40, remain * 1000), token);
    }
  }

  async function replaySide(side, sideData, token, startedAt) {
    const isInsight = side === "insight";
    setStatus(side, "waiting", "waiting");
    showWaiting(
      side,
      isInsight
        ? "Waiting for InSight-doc-8B first token…"
        : "Waiting for Qwen3-VL-8B first token…"
    );

    const turns = sideData.turns || [];
    let zoomRound = 0;
    let finalAnswer = sideData.extracted_answer || "";

    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (token !== state.runToken) return;
      const turn = turns[turnIndex];
      await waitUntil(turn.start_s || 0, startedAt, token);
      if (token !== state.runToken) return;

      clearWaiting(side);
      setStatus(side, "running", "running");

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
      await waitUntil((turn.start_s || 0) + ttft, startedAt, token);
      if (token !== state.runToken) return;

      const streamBudgetMs = Math.max(0, (duration - ttft) * 1000);
      const thinkText = (turn.think || "").trim();
      const answerText = (turn.answer || "").trim();

      if (turn.type === "tool_call") {
        if (thinkText || (turn.display_chunks || []).length) {
          const thinkCard = addEventCard(side, "think", "Thinking");
          const thinkChunks = chunksBeforeToolCall(turn.display_chunks);
          if (thinkChunks.length) {
            await streamChunks(side, thinkCard.body, thinkChunks, streamBudgetMs, token);
            if (!thinkCard.body.textContent.trim() && thinkText) {
              thinkCard.body.textContent = thinkText;
            }
          } else {
            await streamText(side, thinkCard.body, thinkText, streamBudgetMs, token);
          }
        }

        const tool = turn.tool_call || {};
        const args = tool.arguments || {};
        const toolCard = addEventCard(side, "tool", `Tool Call · Round ${zoomRound}`);
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

        const traces = turn.tool_call_traces || [];
        const trace = traces[0] || null;
        const cropIdxs = turn.crop_presented_indices || [];

        if (trace) {
          await waitUntil(trace.start_s || turn.end_s || 0, startedAt, token);
        }
        if (token !== state.runToken) return;

        if (Array.isArray(args.bbox_2d) && typeof args.img_idx === "number") {
          try {
            const overlay = await renderBboxOverlay(sideData, args.img_idx, args.bbox_2d);
            appendToolImages(toolCard.body, [{ label: "BBox overlay", url: overlay }]);
          } catch (err) {
            const note = document.createElement("div");
            note.className = "event-meta";
            note.textContent = `BBox overlay unavailable (${err.message})`;
            toolCard.body.appendChild(note);
          }
        }

        if (trace) {
          await waitUntil(trace.end_s || turn.end_s || 0, startedAt, token);
        } else {
          await waitUntil(turn.end_s || 0, startedAt, token);
        }
        if (token !== state.runToken) return;

        for (const cropIdx of cropIdxs) {
          try {
            const cropUrl = await renderPresentedImage(sideData, cropIdx);
            appendToolImages(toolCard.body, [{ label: `Crop · image ${cropIdx}`, url: cropUrl }]);
          } catch (err) {
            const note = document.createElement("div");
            note.className = "event-meta";
            note.textContent = `Crop ${cropIdx} unavailable (${err.message})`;
            toolCard.body.appendChild(note);
          }
        }
      } else {
        if (thinkText) {
          const thinkCard = addEventCard(side, "think", "Thinking");
          await streamText(side, thinkCard.body, thinkText, streamBudgetMs * 0.4, token);
        }
        const answerCard = addEventCard(side, "answer", "Answer");
        const answerBudget = thinkText ? streamBudgetMs * 0.6 : streamBudgetMs;
        if ((turn.display_chunks || []).length && !answerText) {
          await streamChunks(side, answerCard.body, turn.display_chunks, answerBudget, token);
        } else {
          await streamText(
            side,
            answerCard.body,
            answerText || finalAnswer,
            answerBudget,
            token
          );
        }
        if (answerCard.body.textContent.trim()) {
          finalAnswer = answerCard.body.textContent.trim();
        }
        await waitUntil(turn.end_s || 0, startedAt, token);
      }
    }

    await waitUntil(sideData.wall_time_s || 0, startedAt, token);
    if (token !== state.runToken) return;
    clearWaiting(side);
    setStatus(side, "done", "done");
    return {
      wallTime: sideData.wall_time_s,
      answer: finalAnswer || sideData.extracted_answer || "",
      zoomRounds: zoomRound,
    };
  }

  function renderResults(baselineResult, insightResult) {
    els.comparisonCard.hidden = false;
    els.metricBaselineTime.textContent = formatSeconds(baselineResult?.wallTime);
    els.metricInsightTime.textContent = formatSeconds(insightResult?.wallTime);
    els.metricZoomRounds.textContent = String(insightResult?.zoomRounds ?? state.insight.zoomRounds ?? 0);
    els.metricBaselineAnswer.textContent = baselineResult?.answer || state.example?.baseline?.extracted_answer || "";
    els.metricInsightAnswer.textContent = insightResult?.answer || state.example?.insight?.extracted_answer || "";
    els.metricGroundTruth.textContent = formatGroundTruth(state.example?.ground_truth || "");
  }

  async function runComparison() {
    if (!state.example || state.running) return;
    state.running = true;
    state.runToken += 1;
    const token = state.runToken;
    clearTimers();
    resetStreams();
    els.btnRun.disabled = true;
    els.btnReset.disabled = false;
    els.exampleSelect.disabled = true;

    const startedAt = performance.now();
    try {
      const [baselineResult, insightResult] = await Promise.all([
        replaySide("baseline", state.example.baseline, token, startedAt),
        replaySide("insight", state.example.insight, token, startedAt),
      ]);
      if (token === state.runToken) {
        renderResults(baselineResult, insightResult);
      }
    } catch (err) {
      if (token === state.runToken) {
        setStatus("baseline", "error", "error");
        setStatus("insight", "error", "error");
        const { body } = addEventCard("baseline", "think", "Error");
        body.textContent = err.message || String(err);
      }
    } finally {
      if (token === state.runToken) {
        state.running = false;
        els.btnRun.disabled = false;
        els.exampleSelect.disabled = false;
      }
    }
  }

  function stopAndReset() {
    state.runToken += 1;
    state.running = false;
    clearTimers();
    resetStreams();
    els.btnRun.disabled = false;
    els.btnReset.disabled = true;
    els.exampleSelect.disabled = false;
  }

  function renderPdfThumbnails(example) {
    const pages = example?.insight?.pages || [];
    els.pdfThumbGrid.innerHTML = "";
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
      option.textContent = `${item.label} (${item.page_count}p)`;
      els.exampleSelect.appendChild(option);
    }
  }

  async function loadExample(exampleId) {
    stopAndReset();
    els.questionText.textContent = "Loading example…";
    els.pdfThumbGrid.textContent = "Loading pages…";
    const meta = (state.manifest.examples || []).find((item) => item.id === exampleId);
    const path = meta?.path || `data/examples/${exampleId}.json`;
    const res = await fetch(`./${path.replace(/^\.\//, "")}`);
    if (!res.ok) throw new Error(`Failed to load example (${res.status})`);
    const example = await res.json();
    state.example = example;
    state.exampleId = example.id;
    els.exampleSelect.value = example.id;
    els.questionText.textContent = example.question || "";
    els.caseMeta.textContent = `${example.label} · ${example.benchmark} · ${example.page_count} pages`;
    els.baselineRes.textContent = `r=${Number(example.baseline?.initial_rescale ?? 0.7)}`;
    els.insightRes.textContent = `r=${Number(example.insight?.initial_rescale ?? 0.35)}`;
    els.metricGroundTruth.textContent = formatGroundTruth(example.ground_truth || "");
    renderPdfThumbnails(example);
  }

  async function init() {
    els.btnRun.disabled = true;
    const res = await fetch(`${DATA_BASE}/examples.json`);
    if (!res.ok) throw new Error(`Failed to load examples.json (${res.status})`);
    state.manifest = await res.json();
    populateExampleSelect(state.manifest);
    const initialId = state.manifest.default_example_id || state.manifest.examples?.[0]?.id;
    await loadExample(initialId);
    els.btnRun.disabled = false;
  }

  els.btnRun.addEventListener("click", () => {
    runComparison();
  });
  els.btnReset.addEventListener("click", () => {
    stopAndReset();
  });
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
