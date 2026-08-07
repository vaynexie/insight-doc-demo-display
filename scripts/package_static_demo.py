#!/usr/bin/env python3
"""Package curated trajectory pairs into a portable static Pages data tree."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from PIL import Image

BUNDLE_ROOTS = {
    "default": Path(
        "/Users/xieweiyan/Downloads/rl_ckpt700_actor_merged_hf_broad_fast_rescale025_20260525"
        "/demo_trajectory_candidates_rl_r035_base_r07_legacy_prompt_v2_20260804"
    ),
    "highpage": Path(
        "/Users/xieweiyan/Downloads/rl_ckpt700_actor_merged_hf_broad_fast_rescale025_20260525"
        "/demo_trajectory_candidates_highpage30_rl_r035_base_r07_legacy_prompt_v2_20260805"
    ),
}
OUT_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = OUT_ROOT / "data"

EXAMPLE_SPECS = [
    {
        "id": "062_longdocurl_longdocurl_free_gpt4o_4055915_52_81_6",
        "benchmark": "longdocurl",
        "label": "LongDocURL · contest prize money",
        "bundle": "default",
    },
    {
        "id": "016_longdocurl0507_highpage_longdocurl_free_gemini15_pro_4081367_50_79_1",
        "benchmark": "longdocurl0507_highpage",
        "label": "LongDocURL highpage · canvas weight",
        "bundle": "highpage",
    },
    {
        "id": "055_mmlongbench_mmlongbench_289",
        "benchmark": "mmlongbench",
        "label": "MMLongBench-Doc · HOVER gap",
        "bundle": "default",
    },
    {
        "id": "048_mmlongbench_mmlongbench_344",
        "benchmark": "mmlongbench",
        "label": "MMLongBench-Doc · Trump confidence",
        "bundle": "default",
    },
    {
        "id": "053_mmlongbench_mmlongbench_842",
        "benchmark": "mmlongbench",
        "label": "MMLongBench-Doc · album volume gap",
        "bundle": "default",
    },
    {
        "id": "056_mmlongbench_mmlongbench_688",
        "benchmark": "mmlongbench",
        "label": "MMLongBench-Doc · campaign grade",
        "bundle": "default",
    },
    {
        "id": "004_mmlongbench0507_highpage_mmlongbench_871",
        "benchmark": "mmlongbench0507_highpage",
        "label": "MMLongBench-Doc highpage · Fig.4 efficiency",
        "bundle": "highpage",
    },
    {
        "id": "018_mmlongbench0507_highpage_mmlongbench_779",
        "benchmark": "mmlongbench0507_highpage",
        "label": "MMLongBench-Doc highpage · QK-norm spike",
        "bundle": "highpage",
    },
    {
        "id": "035_mpdocvqa_mpdocvqa_63159",
        "benchmark": "mpdocvqa",
        "label": "MPDocVQA · males in 21-A",
        "bundle": "default",
    },
    {
        "id": "034_mpdocvqa_mpdocvqa_4746",
        "benchmark": "mpdocvqa",
        "label": "MPDocVQA · cellular telephone",
        "bundle": "default",
    },
    {
        "id": "033_mpdocvqa_mpdocvqa_55459",
        "benchmark": "mpdocvqa",
        "label": "MPDocVQA · demat shares",
        "bundle": "default",
    },
    {
        "id": "113_o3bench0502_o3bench_chart_312",
        "benchmark": "o3bench0502",
        "label": "O3-Bench · Speakers customer",
        "bundle": "default",
    },
    {
        "id": "089_mmlite_Reasoning_Autonomous_Driving_Attention_TrafficSignal_0073",
        "benchmark": "mmlite",
        "label": "MME-RealWorld-Lite · traffic signal",
        "bundle": "default",
    },
]

THUMB_SCALE = 0.2
THUMB_QUALITY = 78


def resolve_bundle(spec: dict[str, Any]) -> Path:
    key = spec.get("bundle") or "default"
    if key not in BUNDLE_ROOTS:
        raise KeyError(f"Unknown bundle key: {key}")
    return BUNDLE_ROOTS[key]


def load_record(bundle_root: Path, side: str, benchmark: str, example_id: str) -> dict[str, Any]:
    path = bundle_root / "exported_conversations" / side / benchmark / f"{example_id}.json"
    if not path.exists():
        raise FileNotFoundError(path)
    return json.loads(path.read_text(encoding="utf-8"))


def extract_question(record: dict[str, Any]) -> str:
    for msg in record.get("conversation", []):
        content = msg.get("content") or {}
        if isinstance(content, dict) and content.get("question"):
            return str(content["question"])
    return ""


def format_ground_truth(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(v) for v in value)
    if value is None:
        return ""
    text = str(value).strip()
    if text.startswith("[") and text.endswith("]"):
        try:
            parsed = json.loads(text.replace("'", '"'))
            if isinstance(parsed, list):
                return ", ".join(str(v) for v in parsed)
        except json.JSONDecodeError:
            pass
    return text


def parse_tool_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def compact_presented(ref: dict[str, Any]) -> dict[str, Any]:
    out = {
        "presented_img_idx": ref.get("presented_img_idx"),
        "kind": ref.get("kind"),
        "source_original_img_idx": ref.get("source_original_img_idx"),
        "bbox_on_original": ref.get("bbox_on_original"),
        "display_size": ref.get("display_size"),
        "original_size": ref.get("original_size"),
        "initial_rescale": ref.get("initial_rescale"),
    }
    return {k: v for k, v in out.items() if v is not None}


def crop_indices_after_tool(record: dict[str, Any], tool_message_idx: int) -> list[int]:
    for msg in record.get("conversation", []):
        if msg.get("message_idx") != tool_message_idx + 1:
            continue
        if msg.get("type") not in ("tool_result", "tool_result_fail_hint"):
            continue
        content = msg.get("content") or {}
        idxs = content.get("presented_img_indices") or []
        return [int(i) for i in idxs if isinstance(i, int)]
    return []


def compact_side(record: dict[str, Any], side: str) -> dict[str, Any]:
    loop = (record.get("parameters") or {}).get("loop") or {}
    timing = loop.get("timing") or {}
    reward = record.get("reward") or {}
    msg_by_idx = {
        m.get("message_idx"): m
        for m in record.get("conversation", [])
        if isinstance(m.get("message_idx"), int)
    }

    turns: list[dict[str, Any]] = []
    for trace in loop.get("turn_trace") or []:
        message_idx = trace.get("message_idx")
        msg = msg_by_idx.get(message_idx) or {}
        content = msg.get("content") or {}
        msg_type = msg.get("type") or "answer"
        tool = content.get("tool_call") or {}
        tool_traces = []
        for tc in trace.get("tool_call_traces") or []:
            args = parse_tool_arguments(tc.get("arguments"))
            tool_traces.append(
                {
                    "name": tc.get("name") or tool.get("name") or "image_zoom_in_tool",
                    "start_s": float(tc.get("start_s") or 0.0),
                    "end_s": float(tc.get("end_s") or 0.0),
                    "duration_s": float(tc.get("duration_s") or 0.0),
                    "ok": bool(tc.get("ok", True)),
                    "arguments": args,
                    "new_presented_images": tc.get("new_presented_images"),
                }
            )

        turn: dict[str, Any] = {
            "message_idx": message_idx,
            "type": msg_type,
            "start_s": float(trace.get("start_s") or 0.0),
            "end_s": float(trace.get("end_s") or 0.0),
            "time_to_first_token_s": float(trace.get("time_to_first_token_s") or 0.0),
            "duration_s": float(trace.get("duration_s") or 0.0),
            "think": (content.get("think") or "").strip(),
            "display_chunks": list(trace.get("display_chunks") or []),
            "tool_call_traces": tool_traces,
        }
        if msg_type == "tool_call":
            args = tool.get("arguments") or {}
            if not isinstance(args, dict):
                args = parse_tool_arguments(args)
            turn["tool_call"] = {
                "name": tool.get("name") or "image_zoom_in_tool",
                "arguments": args,
            }
            if isinstance(message_idx, int):
                turn["crop_presented_indices"] = crop_indices_after_tool(record, message_idx)
        elif msg_type in ("answer", "answer_revision"):
            turn["answer"] = (content.get("answer") or "").strip()
        turns.append(turn)

    pages = []
    for ref in (record.get("image_references") or {}).get("input_images") or []:
        value = ref.get("value") or ""
        filename = Path(value).name
        pages.append(
            {
                "original_img_idx": ref.get("original_img_idx"),
                "src": f"images/{filename}",
                "thumb": f"thumbs/{filename}",
                "original_size": ref.get("original_size"),
            }
        )

    return {
        "side": side,
        "label": "InSight-doc-8B" if side == "rl" else "Qwen3-VL-8B",
        "initial_rescale": float(loop.get("initial_rescale") or (0.35 if side == "rl" else 0.7)),
        "wall_time_s": float(timing.get("conversation_wall_time") or 0.0),
        "core_time_s": float(timing.get("core_inference_time") or 0.0),
        "extracted_answer": reward.get("extracted_answer") or "",
        "accuracy": float(((reward.get("score") or {}).get("accuracy_reward")) or 0.0),
        "pages": pages,
        "presented_images": [
            compact_presented(ref)
            for ref in (record.get("image_references") or {}).get("presented_images") or []
        ],
        "turns": turns,
    }


def ensure_image_assets(image_refs: set[tuple[str, str]]) -> None:
    images_dir = DATA_ROOT / "images"
    thumbs_dir = DATA_ROOT / "thumbs"
    images_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    for bundle_key, value in sorted(image_refs):
        bundle_root = BUNDLE_ROOTS[bundle_key]
        src = bundle_root / value
        if not src.exists():
            raise FileNotFoundError(f"Missing image: {src}")
        filename = Path(value).name
        dst = images_dir / filename
        if not dst.exists() or dst.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dst)

        thumb_path = thumbs_dir / filename
        if thumb_path.exists():
            continue
        with Image.open(src) as image:
            rgb = image.convert("RGB")
            width, height = rgb.size
            resized = rgb.resize(
                (max(1, int(width * THUMB_SCALE)), max(1, int(height * THUMB_SCALE))),
                Image.Resampling.LANCZOS,
            )
            resized.save(thumb_path, format="JPEG", quality=THUMB_QUALITY, optimize=True)


def package() -> None:
    if DATA_ROOT.exists():
        shutil.rmtree(DATA_ROOT)
    examples_dir = DATA_ROOT / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)

    all_images: set[tuple[str, str]] = set()
    manifest_examples: list[dict[str, Any]] = []

    for spec in EXAMPLE_SPECS:
        example_id = spec["id"]
        benchmark = spec["benchmark"]
        bundle_key = spec.get("bundle") or "default"
        bundle_root = resolve_bundle(spec)
        rl = load_record(bundle_root, "rl", benchmark, example_id)
        base = load_record(bundle_root, "base", benchmark, example_id)

        for ref in (rl.get("image_references") or {}).get("input_images") or []:
            value = ref.get("value")
            if value:
                all_images.add((bundle_key, value))

        compact = {
            "id": example_id,
            "benchmark": benchmark,
            "label": spec["label"],
            "question": extract_question(rl),
            "ground_truth": format_ground_truth((rl.get("reward") or {}).get("ground_truth")),
            "document_id": example_id,
            "page_count": len((rl.get("image_references") or {}).get("input_images") or []),
            "insight": compact_side(rl, "rl"),
            "baseline": compact_side(base, "base"),
        }

        out_path = examples_dir / f"{example_id}.json"
        out_path.write_text(json.dumps(compact, ensure_ascii=False, indent=2), encoding="utf-8")

        manifest_examples.append(
            {
                "id": example_id,
                "benchmark": benchmark,
                "label": spec["label"],
                "question": compact["question"],
                "page_count": compact["page_count"],
                "path": f"data/examples/{example_id}.json",
                "insight_wall_time_s": compact["insight"]["wall_time_s"],
                "baseline_wall_time_s": compact["baseline"]["wall_time_s"],
                "insight_answer": compact["insight"]["extracted_answer"],
                "baseline_answer": compact["baseline"]["extracted_answer"],
                "ground_truth": compact["ground_truth"],
            }
        )
        print(f"packed {example_id} ({compact['page_count']} pages)")

    ensure_image_assets(all_images)

    manifest = {
        "version": 1,
        "title": "InSight-doc-8B vs Qwen3-VL-8B",
        "insight_label": "InSight-doc-8B",
        "baseline_label": "Qwen3-VL-8B",
        "insight_rescale": 0.35,
        "baseline_rescale": 0.7,
        "default_example_id": EXAMPLE_SPECS[0]["id"],
        "examples": manifest_examples,
    }
    (DATA_ROOT / "examples.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    image_bytes = sum(p.stat().st_size for p in (DATA_ROOT / "images").glob("*"))
    thumb_bytes = sum(p.stat().st_size for p in (DATA_ROOT / "thumbs").glob("*"))
    print(
        f"done: {len(manifest_examples)} examples, {len(all_images)} images, "
        f"images={image_bytes/1e6:.1f}MB thumbs={thumb_bytes/1e6:.1f}MB"
    )


if __name__ == "__main__":
    package()
