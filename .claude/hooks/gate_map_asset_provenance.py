#!/usr/bin/env python3
"""맵 에셋 출처 게이트 — Dust2 원본 반입 차단(RQ-30, ADR-0007 결정 1).

CLAUDE.md 금지: "Dust2 원본 지오메트리·텍스처·에셋의 복제·반입".
ADR-0007 결정 1: "Valve의 Dust2 원본 지오메트리·텍스처·머티리얼을 참조하지
않고 원본 제작한다 ... 원본 게임의 참고 이미지·영상을 자산 소스로 직접
트레이싱·리토폴로지하지 않는다."

**왜 골든이 아니라 게이트인가.** 골든은 "시스템이 X를 한다"는 **행위**를
검증한다. 이 규범은 "저장소에 Y가 없다"는 **부재**의 증명이라 given/when/then의
when이 비어 버린다. 부재는 실행 시점이 아니라 **커밋 시점에 차단**하는 것이
자연스럽다(원장 26r, 2026-07-29 사용자 위임 결정).

⚠️ **이 게이트가 막지 못하는 것 — 반드시 읽어라.**
  이것은 **실수와 부주의만** 막는다. 다음은 원리적으로 검출할 수 없다:
    - 원본을 보고 **다시 모델링**한 지오메트리(리토폴로지)
    - 스크린샷을 **트레이싱**해 그린 텍스처
    - 이름을 바꾸고 재저장해 해시가 달라진 파일
    - **새 파일의 내용** — PreToolUse는 쓰기 **전**이라 파일이 아직 없다.
      내용 검사는 `--check-paths`(CI, 커밋된 파일 대상)에서만 실효가 있다.
  즉 **통과가 곧 결백의 증명이 아니다.** 그 판단은 사람이 하고, ADR-0007
  결정 1이 그 규범을 소유한다. 이 게이트는 "누가 실수로 원본 파일을
  드래그해 넣는 것"을 막는 마지막 방어선일 뿐이다.

실행 모드
---------
  (stdin에 JSON)      PreToolUse hook. exit 2 = 도구 호출 차단.
  --check-paths P...  주어진 경로를 검사. 걸리면 exit 1. (CI용)
  --selftest          내장 검증. 게이트 자체가 고장 났는지 확인한다.

`gate_spec_freeze.py`와 같은 이유로 **판정 로직을 이 파일 하나가 소유한다** —
hook과 CI가 각자 패턴을 들면 언젠가 어긋나고, 로컬에선 막히는데 CI는
통과하는 게이트는 신뢰를 잃어 곧 무시된다.
"""
import json
import re
import sys
from pathlib import Path

def _force_utf8() -> None:
    """stdout·stderr를 UTF-8로 고정 — `gate_spec_freeze.py`와 동일한 이유.

    Windows 한국어 로케일의 기본 콘솔 인코딩은 cp949라서 한글이나 em-dash(—)를
    그대로 출력하면 UnicodeEncodeError로 프로세스가 죽는다. 게이트가 스펙과
    무관한 이유로 죽으면 CI는 그것을 "게이트 실패"로 보고하고, 사람은 원인을
    찾다가 게이트를 꺼버린다.

    이 저장소는 이 결함을 이미 이름 붙여 고쳐 뒀는데 이 훅이 처음 작성될 때
    그것을 복사하지 않아 재발했다(원장 26r 리뷰 blocker B4).
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass  # 재설정 실패해도 메시지는 내보낸다

# 파일 경로·이름에서 원본 반입을 시사하는 패턴.
# 소문자로 정규화한 전체 경로에 대해 검사한다.
FORBIDDEN_PATH_PATTERNS = [
    (r"de[_-]?dust", "Valve 맵 파일명 규약(de_dust2)"),
    # `\b`는 `_` 뒤에서 걸리지 않는다(`_`도 단어 문자다) — selftest가 이 결함을
    # 잡았다(`dust2_layout.gltf`·`csgo_sand.png`가 통과했다). 경계를 직접 쓴다.
    (r"(?<![a-z0-9])dust[ _-]?2(?![a-z0-9])", "Dust2 직접 지칭"),
    (r"(?<![a-z0-9])csgo(?![a-z0-9])|counter[_-]?strike", "Counter-Strike 에셋 출처 시사"),
    (r"\.vpk$", "Valve 팩 파일"),
    (r"\.bsp$", "Source 엔진 맵 컴파일 산출물"),
    (r"\.vtf$|\.vmt$", "Source 엔진 텍스처·머티리얼"),
    (r"\.mdl$|\.vtx$|\.vvd$", "Source 엔진 모델"),
]

# 에셋으로 간주하는 확장자 — 이 확장자 파일은 이름 검사에 더해
# 내부 문자열까지 훑는다(glTF는 텍스트 JSON이라 노드명이 그대로 남는다).
ASSET_SUFFIXES = {".gltf", ".glb", ".obj", ".fbx", ".dae", ".blend"}

# 에셋 내부에서 발견되면 안 되는 문자열(노드명·머티리얼명에 남는 흔적).
FORBIDDEN_CONTENT_PATTERNS = [
    (rb"de_dust", "glTF 노드·머티리얼명에 Valve 맵 이름"),
    (rb"dust2", "에셋 내부에 Dust2 지칭"),
]


def scan_path(path_str: str) -> list[str]:
    """경로 하나를 검사해 위반 사유 목록을 돌려준다(없으면 빈 리스트)."""
    hits: list[str] = []
    lowered = path_str.replace("\\", "/").lower()

    for pattern, why in FORBIDDEN_PATH_PATTERNS:
        if re.search(pattern, lowered):
            hits.append("경로/파일명 — %s (`%s`)" % (why, pattern))

    p = Path(path_str)
    if p.suffix.lower() in ASSET_SUFFIXES and p.exists() and p.is_file():
        try:
            blob = p.read_bytes()
        except OSError:
            return hits
        low = blob.lower()
        for pattern, why in FORBIDDEN_CONTENT_PATTERNS:
            if re.search(pattern, low):
                hits.append("파일 내용 — %s" % why)
    return hits


def _block(path_str: str, hits: list[str]) -> None:
    _force_utf8()
    lines = [
        "",
        "🚫 맵 에셋 출처 게이트 — 차단됨",
        "",
        "  대상: %s" % path_str,
    ]
    for h in hits:
        lines.append("  사유: %s" % h)
    lines += [
        "",
        "  CLAUDE.md 금지: Dust2 원본 지오메트리·텍스처·에셋의 복제·반입.",
        "  ADR-0007 결정 1: 원본을 참조하지 않고 제작한다. \"Dust2 분위기\"는",
        "  색조·재질의 유사로만 한정하며 레이아웃은 독자 설계다(RQ-30).",
        "",
        "  푸는 법: 원본에서 파생되지 않은 자산으로 교체한다. 파일명만 바꾸는",
        "  것은 해결이 아니다 — 이 게이트가 못 잡을 뿐 규범 위반은 그대로다.",
        "",
    ]
    sys.stderr.write("\n".join(lines))
    sys.exit(2)


def run_hook() -> None:
    # stdin을 **바이트로** 읽어 UTF-8로 명시 디코딩한다(기존 훅과 동일).
    # `json.load(sys.stdin)`은 cp949 텍스트 스트림을 쓰고, `except ValueError`가
    # UnicodeDecodeError(ValueError의 하위 클래스)를 **삼켜** 조용히 통과시킨다.
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)  # 입력을 못 읽으면 통과시킨다 — 게이트가 작업을 막지 않는다.

    tool_input = payload.get("tool_input") or {}
    path_str = tool_input.get("file_path") or tool_input.get("path") or ""
    if not path_str:
        sys.exit(0)

    hits = scan_path(path_str)
    if hits:
        _block(path_str, hits)
    sys.exit(0)


def run_check_paths(paths: list[str]) -> None:
    _force_utf8()
    bad = False
    for path_str in paths:
        hits = scan_path(path_str)
        if hits:
            bad = True
            print("위반: %s" % path_str)
            for h in hits:
                print("  - %s" % h)
    if bad:
        print("\n맵 에셋 출처 게이트 — 위 항목이 CLAUDE.md·ADR-0007 결정 1을 위반한다.")
        sys.exit(1)
    print("[맵 에셋 출처 게이트] 위반 0건.")


def run_selftest() -> None:
    """게이트가 실제로 잡고 실제로 통과시키는지 확인한다.

    통과 케이스가 없으면 "전부 막는 게이트"가 되어도 알 수 없다.
    """
    _force_utf8()
    must_block = [
        "assets/maps/de_dust2.glb",
        "assets/maps/Dust2_layout.gltf",
        "public/textures/csgo_sand.png",
        "assets/map.vpk",
        "assets/maps/arena.bsp",
    ]
    must_pass = [
        "assets/maps/arena.glb",
        "src/shared/sim/movement.ts",
        "harness/adr/0007-map-asset-pipeline.md",
        "assets/textures/sandstone_wall.png",
        "assets/maps/dustbin_prop.glb",  # "dust"를 포함하지만 dust2가 아니다
    ]
    failed = []
    for p in must_block:
        if not scan_path(p):
            failed.append("막아야 하는데 통과: %s" % p)
    for p in must_pass:
        hits = scan_path(p)
        if hits:
            failed.append("통과해야 하는데 막힘: %s (%s)" % (p, hits))
    if failed:
        for f in failed:
            print("selftest 실패 — %s" % f)
        sys.exit(1)
    print("[맵 에셋 출처 게이트 selftest] 통과 — 차단 %d건·허용 %d건 확인."
          % (len(must_block), len(must_pass)))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        run_selftest()
    elif len(sys.argv) > 1 and sys.argv[1] == "--check-paths":
        run_check_paths(sys.argv[2:])
    else:
        run_hook()
