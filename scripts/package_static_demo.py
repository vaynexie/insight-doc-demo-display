#!/usr/bin/env python3
"""Package curated trajectory pairs into a portable static Pages data tree."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

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
TOOL_IMAGE_QUALITY = 88
TOOL_THUMB_QUALITY = 78
TOOL_THUMB_MAX_WIDTH = {
    "bbox": 180,
    "crop": 360,
}


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


def side_page_by_original_idx(side_data: dict[str, Any], original_idx: Any) -> dict[str, Any] | None:
    for page in side_data.get("pages") or []:
        if page.get("original_img_idx") == original_idx:
            return page
    return None


def side_presented_by_idx(side_data: dict[str, Any], presented_idx: Any) -> dict[str, Any] | None:
    for ref in side_data.get("presented_images") or []:
        if ref.get("presented_img_idx") == presented_idx:
            return ref
    return None


def clamp_int(value: Any, lower: int, upper: int) -> int:
    return max(lower, min(upper, round(float(value))))


def render_presented_tool_image(side_data: dict[str, Any], presented_idx: int) -> Image.Image:
    presented = side_presented_by_idx(side_data, presented_idx)
    if not presented:
        raise ValueError(f"Missing presented image {presented_idx}")

    source_idx = presented.get("source_original_img_idx")
    page = side_page_by_original_idx(side_data, source_idx)
    if not page:
        raise ValueError(f"Missing source page for presented image {presented_idx}")

    src = DATA_ROOT / page["src"]
    with Image.open(src) as raw:
        image = raw.convert("RGB")

    width, height = image.size
    sx = 0
    sy = 0
    sw = width
    sh = height
    bbox = presented.get("bbox_on_original")
    if isinstance(bbox, list) and len(bbox) == 4:
        x1 = clamp_int(bbox[0], 0, width)
        y1 = clamp_int(bbox[1], 0, height)
        x2 = clamp_int(bbox[2], 0, width)
        y2 = clamp_int(bbox[3], 0, height)
        sx = min(x1, x2)
        sy = min(y1, y2)
        sw = max(1, abs(x2 - x1))
        sh = max(1, abs(y2 - y1))

    display_size = presented.get("display_size")
    dw = sw
    dh = sh
    if isinstance(display_size, list) and len(display_size) == 2:
        dw = max(1, round(float(display_size[0])))
        dh = max(1, round(float(display_size[1])))

    cropped = image.crop((sx, sy, sx + sw, sy + sh))
    if cropped.size != (dw, dh):
        cropped = cropped.resize((dw, dh), Image.Resampling.LANCZOS)
    return cropped


def project_tool_bbox(
    bbox2d: list[Any],
    presented: dict[str, Any],
    canvas_width: int,
    canvas_height: int,
) -> tuple[int, int, int, int]:
    x1 = float(bbox2d[0])
    y1 = float(bbox2d[1])
    x2 = float(bbox2d[2])
    y2 = float(bbox2d[3])
    bbox_max_x = max(x1, x2)
    bbox_max_y = max(y1, y2)
    display_size = presented.get("display_size")
    original_size = presented.get("original_size")

    if (
        isinstance(display_size, list)
        and len(display_size) == 2
        and min(x1, y1, x2, y2) >= 0
        and bbox_max_x <= 1000
        and bbox_max_y <= 1000
    ):
        dw = float(display_size[0])
        dh = float(display_size[1])
        if dw > 0 and dh > 0:
            x1 = (x1 * dw) / 1000
            x2 = (x2 * dw) / 1000
            y1 = (y1 * dh) / 1000
            y2 = (y2 * dh) / 1000
            bbox_max_x = max(x1, x2)
            bbox_max_y = max(y1, y2)

    if (
        isinstance(original_size, list)
        and len(original_size) == 2
        and isinstance(display_size, list)
        and len(display_size) == 2
    ):
        ow = float(original_size[0])
        oh = float(original_size[1])
        dw = float(display_size[0])
        dh = float(display_size[1])
        likely_original = (
            ow > 0
            and oh > 0
            and (bbox_max_x > dw or bbox_max_y > dh)
            and bbox_max_x <= ow
            and bbox_max_y <= oh
        )
        if likely_original:
            x1 = (x1 * dw) / ow
            x2 = (x2 * dw) / ow
            y1 = (y1 * dh) / oh
            y2 = (y2 * dh) / oh

    if isinstance(display_size, list) and len(display_size) == 2:
        dw = float(display_size[0])
        dh = float(display_size[1])
        if dw > 0 and dh > 0 and (dw != canvas_width or dh != canvas_height):
            x1 = (x1 * canvas_width) / dw
            x2 = (x2 * canvas_width) / dw
            y1 = (y1 * canvas_height) / dh
            y2 = (y2 * canvas_height) / dh

    x1 = max(0, min(canvas_width - 1, round(x1)))
    x2 = max(0, min(canvas_width - 1, round(x2)))
    y1 = max(0, min(canvas_height - 1, round(y1)))
    y2 = max(0, min(canvas_height - 1, round(y2)))
    if x1 == x2:
        x2 = min(canvas_width - 1, x1 + 1)
    if y1 == y2:
        y2 = min(canvas_height - 1, y1 + 1)
    return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)


def render_bbox_tool_image(
    side_data: dict[str, Any],
    presented_idx: int,
    bbox2d: list[Any],
) -> Image.Image:
    presented = side_presented_by_idx(side_data, presented_idx)
    if not presented:
        raise ValueError(f"Missing presented image {presented_idx}")
    image = render_presented_tool_image(side_data, presented_idx)
    x1, y1, x2, y2 = project_tool_bbox(bbox2d, presented, image.width, image.height)
    draw = ImageDraw.Draw(image)
    line_width = max(6, round(min(image.width, image.height) / 90))
    draw.rectangle((x1, y1, x2, y2), outline=(255, 80, 60), width=line_width)
    return image


def save_tool_image_pair(
    image: Image.Image,
    example_id: str,
    stem: str,
    kind: str,
) -> dict[str, Any]:
    out_dir = DATA_ROOT / "tool_images" / example_id
    out_dir.mkdir(parents=True, exist_ok=True)
    full_rel = f"tool_images/{example_id}/{stem}_full.jpg"
    thumb_rel = f"tool_images/{example_id}/{stem}_thumb.jpg"

    image.save(DATA_ROOT / full_rel, format="JPEG", quality=TOOL_IMAGE_QUALITY, optimize=True)

    max_width = TOOL_THUMB_MAX_WIDTH[kind]
    scale = min(1.0, max_width / image.width)
    thumb_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    thumb = image if thumb_size == image.size else image.resize(thumb_size, Image.Resampling.LANCZOS)
    thumb.save(DATA_ROOT / thumb_rel, format="JPEG", quality=TOOL_THUMB_QUALITY, optimize=True)

    return {
        "full_src": full_rel,
        "thumb_src": thumb_rel,
        "display_size": [image.width, image.height],
    }


def attach_tool_visuals(compact: dict[str, Any], example_id: str) -> None:
    for side_key in ("insight", "baseline"):
        side_data = compact.get(side_key) or {}
        for turn_index, turn in enumerate(side_data.get("turns") or []):
            if turn.get("type") != "tool_call":
                turn.pop("tool_visuals", None)
                continue

            visuals: list[dict[str, Any]] = []
            args = ((turn.get("tool_call") or {}).get("arguments") or {})
            stem_prefix = f"{side_key}_turn_{turn_index + 1:02d}"
            img_idx = args.get("img_idx")
            bbox2d = args.get("bbox_2d")
            if isinstance(img_idx, int) and isinstance(bbox2d, list) and len(bbox2d) == 4:
                image = render_bbox_tool_image(side_data, img_idx, bbox2d)
                saved = save_tool_image_pair(image, example_id, f"{stem_prefix}_bbox", "bbox")
                visuals.append(
                    {
                        "kind": "bbox",
                        "label": "BBox overlay",
                        "img_idx": img_idx,
                        **saved,
                    }
                )

            for crop_idx in turn.get("crop_presented_indices") or []:
                if not isinstance(crop_idx, int):
                    continue
                image = render_presented_tool_image(side_data, crop_idx)
                saved = save_tool_image_pair(
                    image,
                    example_id,
                    f"{stem_prefix}_crop_{crop_idx}",
                    "crop",
                )
                visuals.append(
                    {
                        "kind": "crop",
                        "label": f"Crop · image {crop_idx}",
                        "img_idx": crop_idx,
                        **saved,
                    }
                )

            turn["tool_visuals"] = visuals


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
    packaged_examples: list[tuple[dict[str, Any], dict[str, Any]]] = []
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

        packaged_examples.append((spec, compact))

    ensure_image_assets(all_images)

    for spec, compact in packaged_examples:
        example_id = spec["id"]
        benchmark = spec["benchmark"]
        attach_tool_visuals(compact, example_id)

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
