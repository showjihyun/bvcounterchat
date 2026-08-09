#!/usr/bin/env python3
r"""스펙 미러 게이트 — 문서가 인용한 수치가 정본과 어긋나는 것을 막는다.

`src/shared/constants.ts`가 스펙 값의 정본이고, `harness/` 아래 문서가 그 값을
문면에 인용한다. 스펙이 개정되면 **미러가 조용히 낡는다.**

## 실제로 일어난 일 (원장 26af·26ag, 전부 실측)

  - RQ-31 반경이 5m→4m로 개정됐을 때 승인 ADR-0007의 "RQ-30~32 **확정값**" 표가
    `5m`으로 남았다. 하필 그 표를 읽을 다음 라운드가 `SPAWN_POINTS`를 실제
    지오메트리로 교체하는 RQ-30 맵 라운드였다.
  - 같은 라운드에 `status: done` 골든 `GA-19`의 given도 `5m`이었다 — **통과하는
    테스트가 틀린 정답지를 만족시키는** 상태다.
  - **둘 다 `check.sh`가 exit 0을 냈다**(델타 재평가가 되살려 실측). 잡은 것은
    사람 눈이고, 원장 26af가 그때 이미 ⬜로 등재돼 있었는데도 **트리거가 발화하지
    않았다.**

## 정본이 세 종류다 — 이것이 이 게이트의 설계 핵심

원장 26af는 처음에 대조 대상을 "스펙 상수"로 좁혀 뒀다. 그런데 PR #39에서 실제로
난 문면 오류 4건은 **상수 파일과 무관**했다:

  1. **상수 파일** — `constants.ts`의 값 (ADR 확정값 표·`done` 골든이 인용)
  2. **실행 출력** — 게이트 `--selftest`의 "차단 N건·허용 M건" (문서가 인용)
  3. **문서 내부 계수** — `sensor-catalog.md`의 ✅ 행 수 (그 문서와 changelog가 인용)

2·3은 **코드를 돌리거나 세어야 알 수 있는 값**이라 상수만 훑는 검사로는 안 잡힌다.
실제로 PR #39의 임시 감사가 2를 잡았으나 3을 `changelog.md`에서 놓쳤다 —
**감사 대상 목록 자체가 구멍이었다.**

## 무엇을 보지 않는가 (오탐을 만들지 않기 위해)

  - `harness/progress.md` — append-only 로그. 옛 값 서술이 본질이다.
  - `harness/changelog.md` — **날짜별 append-only 기록**. 같은 이유다. "2026-07-30에
    ✅ 8행 → 11행으로 정정했다"는 그 시점의 사실이고, 오늘 13행이 됐다고 그 문장을
    13으로 고치면 **이력을 위조하는 것**이다. (배선 첫 라운드에 이 게이트가 실제로
    그 문장을 불일치로 잡았고, 그것이 이 제외 규칙의 근거다.) 대신 원장 26ae가
    "집계 수치에는 시점을 함께 적는다"를 규칙으로 두므로 changelog 인용은 날짜를
    병기해 역사적 서술임을 문면에서 분명히 한다.
  - `harness/specs/interview/**` — 날짜 고정 트랜스크립트. 2026-07-21 결정을
    그대로 옮긴 기록이라 옛 값이 **맞다**. (`question-bank.md`에는 낙하 데미지의
    기각된 대안 "임계 4m"가 있는데 우연히 현재 반경과 같다 — 순진한 대조는
    **틀린 일치**를 낸다.)
  - `requirements.md`의 개정 이력 표(`| v1.5 |` 행) — "5m → 4m"가 본질이다.
  - `status: todo` 골든 — 애초에 미검증이라 대조 대상이 아니다.

즉 **인용이 규범인 곳만** 본다: ADR의 "확정값" 블록 · `status: done` 골든 ·
게이트 수치와 계수를 인용하는 하네스 문서.

## 한계 — 통과가 무엇을 증명하지 않는가

  - **등록부에 있는 것만** 본다. 새 상수를 더해도 자동으로 감시되지 않는다.
  - 인용 표현이 등록된 정규식과 다르면 놓친다. 그물을 넓히면 오탐이 지배하므로
    (실측: `"3초"`가 `RESPAWN_MS`와 `SPAWN_PROTECTION_MS` 둘에 쓰인다) **좁게
    유지하고 selftest로 못박는** 쪽을 택했다.
  - **selftest 수치 대조가 "어느 게이트의 수치인가"와 결합돼 있지 않다.** 인용된
    (차단, 허용) 쌍이 **아무 게이트에나** 존재하면 통과한다. 현재 3개 중 2개가
    이미 `5·5`로 겹쳐 있어 이론적 가정이 아니다 — `gate_ledger_table` 인용을
    `5·5`로 바꿔도 검출되지 않는다(실측). 존재하지 않는 조합은 정상 검출한다.
    (원장 26ap로 이월)
  - 통과는 "모든 문서가 최신"의 증명이 아니다.

실행 모드
---------
  --check          전 대상 검사. 불일치가 있으면 exit 1.
  --selftest       내장 검증. 게이트 자체가 고장 났는지 확인한다.

PreToolUse 훅은 **두지 않는다** — 편집 중에는 스펙과 미러가 일시적으로 어긋나는
것이 정상이다(스펙을 먼저 고치고 미러를 뒤에 고친다). 훅으로 막으면 개정 작업
자체가 불가능해진다.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CONSTANTS = ROOT / "src" / "shared" / "constants.ts"
GOLDEN_DIR = ROOT / "harness" / "evals" / "golden"
ADR_DIR = ROOT / "harness" / "adr"
SENSOR_CATALOG = ROOT / "harness" / "sensor-catalog.md"
# **날짜별 append-only 기록** — 대조 대상이 아니다. 옛 수치가 그 시점의 사실이라
# 오늘 값으로 고치면 이력 위조다. 상수로 적어 두는 이유는 이 판단이 실수가 아니라
# 결정임을 코드에 남기기 위해서다(selftest가 이 제외를 못박는다).
APPEND_ONLY = (
    ROOT / "harness" / "progress.md",
    ROOT / "harness" / "changelog.md",
)

# `NAME: 값,` 형태. 값은 정수·소수·밑줄 구분·간단한 사칙연산까지 받는다
# (`1000 / 30`·`60_000 / 400`·`5 * 60 * 1000`이 실제로 있다).
CONST_LINE = re.compile(r"^\s{2}([A-Z][A-Z0-9_]*):\s*([0-9_.*/ +-]+?),?\s*(?://.*)?$")
OBJECT_LINE = re.compile(r"^export const ([A-Z][A-Za-z0-9_]*)\s*=")
# ADR의 "확정값" 블록 시작.
CONFIRMED = re.compile(r"확정값")
# 게이트 selftest의 "차단 N건·허용 M건". **`건`은 선택**이다 — 게이트 출력은
# "차단 16건·허용 17건"인데 문서 인용은 "차단 16·허용 17·경로 6"으로 `건`을
# 빼고 쓴다. `건`을 필수로 두면 문서 쪽이 아예 매칭되지 않아 이 검사가 조용히
# 아무것도 안 한다(이 게이트를 처음 돌렸을 때 실제로 그랬다).
SELFTEST_COUNTS = re.compile(r"차단\s*\*{0,2}(\d+)\*{0,2}건?·허용\s*\*{0,2}(\d+)\*{0,2}건?")


def _force_utf8() -> None:
    """stdout·stderr를 UTF-8로 고정.

    Windows 한국어 로케일의 기본 콘솔 인코딩은 cp949라서, 한글이나 em-dash(—)를
    그대로 출력하면 UnicodeEncodeError로 프로세스가 죽는다. 게이트가 스펙과
    무관한 이유로 죽으면 CI는 "게이트 실패"로 보고하고 사람은 원인을 찾다가
    게이트를 꺼버린다 — 센서가 죽는 가장 흔한 경로다.

    이 저장소는 이미 그 사고를 냈고(원장 26r blocker B4), 새 훅이 기존 구현을
    복사하지 않아 **재발한** 전례가 있다. 처음부터 넣는다.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass


def _stderr(msg: str) -> None:
    _force_utf8()
    print(msg, file=sys.stderr)


def _num(text: str) -> float | None:
    """`1000 / 30` 같은 단순 산술을 값으로. 실패하면 None."""
    expr = text.replace("_", "").strip()
    if not re.fullmatch(r"[0-9.*/ +-]+", expr):
        return None
    try:
        return float(eval(expr, {"__builtins__": {}}, {}))  # noqa: S307 — 숫자·연산자만
    except (SyntaxError, ZeroDivisionError, TypeError, NameError):
        return None


def read_constants(path: Path = CONSTANTS) -> dict[str, float]:
    """`OBJ.FIELD` → 숫자. 정본을 파싱한다."""
    values: dict[str, float] = {}
    obj = ""
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        m = OBJECT_LINE.match(line)
        if m:
            obj = m.group(1)
            continue
        m = CONST_LINE.match(line)
        if m and obj:
            v = _num(m.group(2))
            if v is not None:
                values["%s.%s" % (obj, m.group(1))] = v
    return values


def fmt(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else ("%g" % v)


# 등록부 — (상수 경로, 사람이 읽는 이름, 인용 정규식 목록).
# **드리프트가 실측된 것부터** 넣는다. 좁게 유지하고 selftest로 못박는다.
MIRRORS: list[tuple[str, str, list[str]]] = [
    ("WORLD.SAFE_ZONE_RADIUS_M", "Safe Zone 반경",
     [r"반경\s*\*{0,2}(\d+(?:\.\d+)?)\s*m"]),
    # ⚠️ 두 수가 **같을 때만** 걸리게 역참조를 쓴다(원장 24bm). 플레이 면적은
    # 정사각형(60×60m)이라 이것이 정확한 형태다. 초안은 `A×Bm` 아무 곱셈이나
    # 잡아서, RQ-72 골든 GA-85가 done으로 전환되는 순간 「19×0.2m」(체공 19틱 ×
    # 틱당 0.2m)를 플레이 면적 주장으로 오해해 **하드 실패**했다 — 실측으로
    # 드러난 과탐이다. 같은 형태의 과탐 축을 SAFE_ZONE_RADIUS_M 패턴도 갖는다
    # (「반경 <수>m」 — 다른 반경이 생기면 걸린다).
    ("WORLD.SIZE_M", "플레이 면적 한 변",
     [r"(\d+(?:\.\d+)?)\s*×\s*\1\s*m"]),
    ("MOVEMENT.SPEED", "기본 이동 속도",
     [r"기본 이동 속도[^|\n]*\|\s*(\d+(?:\.\d+)?)\s*m/s"]),
    ("MOVEMENT.JUMP_HEIGHT", "점프 높이",
     [r"점프 높이[^|\n]*\|\s*(\d+(?:\.\d+)?)\s*m"]),
    ("FALL_DAMAGE.SAFE_HEIGHT_M", "낙하 무피해 임계",
     [r"낙하 데미지[^|\n]*\|\s*(\d+(?:\.\d+)?)m 초과분"]),
    # RQ-72(발소리, 원장 24bm). ADR-0014 결정 4의 확정값 표가 두 값을 인용하고
    # `requirements.md` RQ-72 본문도 같은 수치를 적는다 — 등록하지 않으면 어긋나도
    # 아무도 못 잡는다(원장 28l·28r·28s가 같은 형태로 세 번 발생).
    # ⚠️ 패턴이 `|`를 요구하므로 **표 행만** 걸린다 — 골든 산문(파이프 없음)은
    # 대조 대상이 아니다. 「착지음의 가청 거리 | 발소리와 같다」처럼 값이 숫자가
    # 아닌 행도 자연히 빠진다.
    ("AUDIO.AUDIBLE_RANGE_M", "발소리·착지음 가청 거리",
     [r"가청 거리[^|\n]*\|\s*(\d+(?:\.\d+)?)\s*m"]),
    ("AUDIO.FOOTSTEP_STRIDE_M", "발소리 보폭",
     [r"보폭[^|\n]*\|\s*(\d+(?:\.\d+)?)\s*m"]),
]


def adr_confirmed_lines(text: str) -> list[tuple[int, str]]:
    """ADR에서 "확정값" 블록의 **표 데이터 행만**.

    블록은 `확정값`이 등장한 줄부터 들여쓰기가 풀리는 지점까지로 보고, 그 안에서
    **표 행만** 뽑는다. 확정값은 두 ADR(0004·0007) 모두 표로 적혀 있다.

    **왜 표 행만인가**: 확정값 블록에는 서술도 들어온다. ADR-0007에는 "실제로
    RQ-31 v1.5(**반경 5m**→4m)에서 그 일이 일어났고"라는 경고 블록쿼트가 표 바로
    앞에 있다 — 사건을 **서술**하는 문장이지 확정값 주장이 아니다. 산문까지
    긁으면 그 문장이 오탐이 된다(이 게이트를 처음 돌렸을 때 실제로 그랬다).

    한계: 확정값을 표가 아니라 목록·문장으로 적으면 놓친다. 그물을 넓히면
    서술 오탐이 지배하므로 좁은 쪽을 택했다.
    """
    lines = text.split("\n")
    out: list[tuple[int, str]] = []
    inside = False
    for i, line in enumerate(lines, 1):
        if CONFIRMED.search(line):
            inside = True
            continue
        if not inside:
            continue
        stripped = line.strip()
        if stripped == "":
            continue
        if not line.startswith((" ", "\t", "|")):
            inside = False
            continue
        if not stripped.startswith("|"):
            continue  # 블록쿼트·산문은 확정값 주장이 아니다
        cells = [c.strip() for c in stripped.split("|")]
        if all(set(c) <= set("-: ") for c in cells if c):
            continue  # 구분선
        out.append((i, line))
    return out


def check_constant_mirrors(values: dict[str, float]) -> list[str]:
    """ADR 확정값 블록과 `status: done` 골든의 수치 인용을 정본과 대조."""
    problems: list[str] = []
    targets: list[tuple[str, int, str]] = []

    for adr in sorted(ADR_DIR.glob("*.md")):
        for lineno, line in adr_confirmed_lines(adr.read_text(encoding="utf-8")):
            targets.append((adr.name, lineno, line))

    for jsonl in sorted(GOLDEN_DIR.glob("*.jsonl")):
        for lineno, raw in enumerate(jsonl.read_text(encoding="utf-8").split("\n"), 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                problems.append("  %s:%d JSONL 파싱 실패" % (jsonl.name, lineno))
                continue
            if rec.get("status") != "done":
                continue  # todo는 애초에 미검증이라 대조 대상이 아니다
            body = " ".join(str(rec.get(k, "")) for k in ("given", "when", "then"))
            targets.append(("%s[%s]" % (jsonl.name, rec.get("id")), lineno, body))

    for const, label, patterns in MIRRORS:
        want = values.get(const)
        if want is None:
            problems.append("  등록부의 `%s`를 정본에서 찾지 못했다 — 상수가 "
                            "이름을 바꿨거나 사라졌다" % const)
            continue
        for where, lineno, text in targets:
            for pat in patterns:
                for m in re.finditer(pat, text):
                    got = _num(m.group(1))
                    if got is None or got == want:
                        continue
                    problems.append(
                        "  %s:%d %s가 %s인데 정본 `%s`는 %s다 — 미러가 낡았다"
                        % (where, lineno, label, m.group(1), const, fmt(want))
                    )
    return problems


def gate_selftest_counts() -> dict[str, tuple[int, int]]:
    """각 게이트의 `--selftest`를 돌려 (차단, 허용) 수를 얻는다.

    **이 게이트 자신도 포함한다.** `--selftest`는 `--check`를 부르지 않으므로 재귀가
    아니고, 자신을 빼면 이 게이트가 문서에 적힌 **자기 수치의 드리프트를 잡지
    못하는** 구멍이 남는다 — 다른 모든 게이트에 대해 하는 일을 자기에게만 안 하는
    셈이다.
    """
    out: dict[str, tuple[int, int]] = {}
    for hook in sorted((ROOT / ".claude" / "hooks").glob("gate_*.py")):
        try:
            r = subprocess.run([sys.executable, str(hook), "--selftest"],
                               capture_output=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            continue
        m = SELFTEST_COUNTS.search(r.stdout.decode("utf-8", errors="replace"))
        if m:
            out[hook.stem] = (int(m.group(1)), int(m.group(2)))
    return out


def sensor_ok_rows(text: str) -> int:
    """`sensor-catalog.md` Sensors 표에서 **상태 열이 ✅로 시작하는** 행 수.

    행 단위로 ✅ 포함 여부를 세면 🟡 행의 비고에 든 ✅까지 잡혀 1 많아진다 —
    PR #39에서 실제로 두 번 그렇게 틀렸다.
    """
    split = re.compile(r"(?<!\\)\|")
    inside, count = False, 0
    for line in text.split("\n"):
        if line.startswith("## Sensors"):
            inside = True
            continue
        if inside and line.startswith("## "):
            break
        if not inside or not line.startswith("|"):
            continue
        cells = [c.strip() for c in split.split(line)]
        if len(cells) < 6 or cells[1] == "이름" or set(cells[1]) <= set("-: "):
            continue
        if cells[5].startswith("✅"):
            count += 1
    return count


def check_derived_mirrors() -> list[str]:
    """정본이 **실행 출력**이거나 **문서 내부 계수**인 미러를 대조한다.

    PR #39의 문면 오류 4건이 전부 이 부류였고 상수만 훑는 검사로는 안 잡혔다.
    """
    problems: list[str] = []
    # 정본을 선언하는 문서만 미러로 본다. append-only 기록은 제외한다 —
    # 옛 수치가 그 시점의 사실이므로 오늘 값으로 고치면 이력 위조다.
    docs = [p for p in (SENSOR_CATALOG,) if p.exists() and p not in APPEND_ONLY]

    # (1) 실행 출력 — 게이트 selftest 수치
    counts = gate_selftest_counts()
    for doc in docs:
        text = doc.read_text(encoding="utf-8")
        for lineno, line in enumerate(text.split("\n"), 1):
            for m in SELFTEST_COUNTS.finditer(line):
                cited = (int(m.group(1)), int(m.group(2)))
                if cited in counts.values():
                    continue
                problems.append(
                    "  %s:%d selftest 수치 %d·%d를 인용했는데 실행 출력에 그런 "
                    "게이트가 없다 — 실측: %s"
                    % (doc.name, lineno, cited[0], cited[1],
                       ", ".join("%s %d·%d" % (k, v[0], v[1])
                                 for k, v in sorted(counts.items())) or "없음")
                )

    # (2) 문서 내부 계수 — sensor-catalog의 ✅ 행 수
    if SENSOR_CATALOG.exists():
        want = sensor_ok_rows(SENSOR_CATALOG.read_text(encoding="utf-8"))
        for doc in docs:
            text = doc.read_text(encoding="utf-8")
            for lineno, line in enumerate(text.split("\n"), 1):
                for m in re.finditer(r"(?:✅는|실측)\s*\*{0,2}(\d+)\s*행", line):
                    if int(m.group(1)) == want:
                        continue
                    problems.append(
                        "  %s:%d Sensors ✅ 행 수를 %s로 인용했는데 실측은 %d다"
                        % (doc.name, lineno, m.group(1), want)
                    )
    return problems


def run_check() -> int:
    values = read_constants()
    if not values:
        _stderr("[스펙 미러 게이트] 정본을 읽지 못했다: %s" % CONSTANTS)
        return 1
    problems = check_constant_mirrors(values) + check_derived_mirrors()
    if problems:
        _stderr(
            "[스펙 미러 게이트] 미러 불일치 %d건:\n%s\n"
            "값의 정본은 `src/shared/constants.ts`와 실행 출력이며 문서는 그 "
            "미러다. 스펙을 바꿨다면 미러도 같은 PR에서 고쳐라(원장 26af)."
            % (len(problems), "\n".join(problems))
        )
        return 1
    print("[스펙 미러 게이트] 불일치 0건 (상수 %d개 중 등록부 %d개 대조)."
          % (len(values), len(MIRRORS)))
    return 0


def run_selftest() -> int:
    """게이트 자체의 검증. `must_pass`가 핵심이다 — 이 게이트의 위험은 미탐이
    아니라 **오탐**이다(개정 이력·인터뷰 기록·우연히 같은 숫자)."""
    failed: list[str] = []
    values = {"WORLD.SAFE_ZONE_RADIUS_M": 4.0, "WORLD.SIZE_M": 60.0,
              "MOVEMENT.SPEED": 6.0, "MOVEMENT.JUMP_HEIGHT": 1.0,
              "FALL_DAMAGE.SAFE_HEIGHT_M": 3.0,
              "AUDIO.AUDIBLE_RANGE_M": 15.0, "AUDIO.FOOTSTEP_STRIDE_M": 2.0}

    def scan(text: str) -> list[str]:
        hits = []
        for const, label, patterns in MIRRORS:
            want = values[const]
            for pat in patterns:
                for m in re.finditer(pat, text):
                    got = _num(m.group(1))
                    if got is not None and got != want:
                        hits.append("%s=%s" % (label, m.group(1)))
        return hits

    must_block = [
        ("ADR 확정값 표의 낡은 반경", "| Safe Zone 반경 | 스폰 지점 반경 5m |"),
        ("done 골든의 낡은 반경", "A가 Safe Zone(반경 5m) 내부에서"),
        ("확정값 표의 낡은 이동 속도", "| 기본 이동 속도 | 8 m/s |"),
        ("확정값 표의 낡은 점프 높이", "| 점프 높이 | 1.5 m |"),
        ("낡은 맵 크기", "플레이 면적은 약 80×80m다"),
    ]
    must_pass = [
        ("현재 반경", "| Safe Zone 반경 | 스폰 지점 반경 4m |"),
        ("현재 맵 크기", "플레이 면적은 약 60×60m다"),
        ("현재 이동 속도", "| 기본 이동 속도 | 6 m/s |"),
        ("파생값 인용(앉기 3 m/s)은 대조하지 않는다", "| 앉기 배율 | 50% (3 m/s) |"),
        ("낙하 임계 3m", "| 낙하 데미지 | 3m 초과분 1m당 10 |"),
    ]
    for name, text in must_block:
        if not scan(text):
            failed.append("차단 실패 — %s" % name)
    for name, text in must_pass:
        hit = scan(text)
        if hit:
            failed.append("오탐 — %s: %s" % (name, hit))

    # 확정값 블록 추출 — 서술을 긁으면 개정 이력이 오탐이 된다.
    block = (
        "5. **맵 규모·배치(RQ-30~32 확정값)**:\n"
        "\n"
        "   > ⚠️ 스펙이 개정되면 낡는다. 실제로 RQ-31 v1.5(반경 5m→4m)에서 그랬다.\n"
        "\n"
        "   | 항목 | 값 |\n"
        "   |---|---|\n"
        "   | Safe Zone 반경 | 스폰 지점 반경 4m (v1.5 개정 — 5m→4m) |\n"
        "\n"
        "본문으로 돌아온다. 반경 5m이라고 아무렇게나 적어도 여기는 안 본다.\n"
    )
    picked = adr_confirmed_lines(block)
    if any("블록쿼트" in l or "⚠️" in l for _, l in picked):
        failed.append("확정값 추출 — 블록쿼트 서술을 긁었다(개정 이력 오탐 경로)")
    if any("본문으로 돌아온다" in l for _, l in picked):
        failed.append("확정값 추출 — 블록이 끝난 뒤 본문까지 긁었다")
    if not any("Safe Zone 반경" in l for _, l in picked):
        failed.append("확정값 추출 — 표 데이터 행을 놓쳤다")
    for _, l in picked:
        if scan(l):
            failed.append("확정값 추출 — 표 행의 개정 부기(5m→4m)를 오탐했다: %r" % l)

    # 정본 파서 — 사칙연산·밑줄이 든 실제 형태를 읽는가.
    real = read_constants()
    for const in [c for c, _, _ in MIRRORS]:
        if const not in real:
            failed.append("정본 파싱 실패 — %s" % const)
    for const, want in (("NET.TICK_MS", 1000 / 30),
                        ("WEAPON.FIRE_INTERVAL_MS", 150.0),
                        ("PLAYER.AFK_TIMEOUT_MS", 300000.0)):
        if abs(real.get(const, -1) - want) > 1e-9:
            failed.append("산술 파싱 실패 — %s=%r (기대 %r)"
                          % (const, real.get(const), want))

    # selftest 수치 정규식 — 게이트 출력("차단 16건")과 문서 인용("차단 16")의
    # 표기가 다르다. `건`을 필수로 두면 문서 쪽이 매칭되지 않아 검사가 조용히
    # 아무것도 안 한다(실제로 그랬다).
    for form, want in (("[selftest] 통과 — 차단 16건·허용 17건·경로 6건 확인.", (16, 17)),
                       ("selftest **차단 16·허용 17·경로 6**(허용에 …)", (16, 17)),
                       ("selftest 차단 5건·허용 5건 확인", (5, 5))):
        m = SELFTEST_COUNTS.search(form)
        if not m or (int(m.group(1)), int(m.group(2))) != want:
            failed.append("selftest 수치 정규식 — %r에서 %r를 못 읽었다"
                          % (form[:40], want))

    # 문서 내부 계수 — 행 단위 ✅ 포함으로 세면 1 많아지는 함정.
    sample = ("## Sensors\n| 이름 | 실행 | 배치 | 강제 | 상태 |\n|---|---|---|---|---|\n"
              "| a | C | x | y | ✅ 됨 |\n"
              "| b | C | x | y | 🟡 부분 — 완전 강제(✅)로 올리려면 |\n"
              "## 다음\n")
    if sensor_ok_rows(sample) != 1:
        failed.append("✅ 계수 — 비고의 ✅까지 세면 안 된다(실측 %d, 기대 1)"
                      % sensor_ok_rows(sample))

    # append-only 기록 제외가 **결정**임을 못박는다. 배선 첫 라운드에 이 게이트가
    # `changelog.md`의 "2026-07-30 실측 11행"을 불일치로 잡았고, 그것을 오늘 값으로
    # 고치는 것은 이력 위조다 — 되돌아오기 쉬운 판단이라 selftest로 고정한다.
    if (ROOT / "harness" / "changelog.md") not in APPEND_ONLY:
        failed.append("append-only 제외 — changelog.md가 목록에서 빠졌다")
    if (ROOT / "harness" / "progress.md") not in APPEND_ONLY:
        failed.append("append-only 제외 — progress.md가 목록에서 빠졌다")

    if failed:
        _stderr("[스펙 미러 게이트 selftest] 실패 %d건:\n  %s"
                % (len(failed), "\n  ".join(failed)))
        return 1
    print("[스펙 미러 게이트 selftest] 통과 — 차단 %d건·허용 %d건 확인."
          % (len(must_block), len(must_pass)))
    return 0


def main() -> None:
    _force_utf8()
    argv = sys.argv[1:]
    if not argv:
        _stderr("이 게이트는 PreToolUse 훅으로 쓰지 않는다 — 편집 중에는 스펙과 "
                "미러가 일시적으로 어긋나는 것이 정상이다.\n%s" % __doc__)
        sys.exit(64)
    mode = argv[0]
    if mode == "--check":
        sys.exit(run_check())
    if mode == "--selftest":
        sys.exit(run_selftest())
    _stderr("알 수 없는 모드: %s\n%s" % (mode, __doc__))
    sys.exit(64)


if __name__ == "__main__":
    main()
