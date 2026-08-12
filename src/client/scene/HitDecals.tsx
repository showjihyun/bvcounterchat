import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { StoreApi } from 'zustand/vanilla'
import type { GameStoreState } from '@client/store/gameStore'
import { CAPACITY, EFFECTS, WEAPON } from '@shared/constants'
import { EFFECTS_TUNING } from '@shared/config/effects-tuning'
import { DECAL } from '@client/config/design-tokens'
import { createDecalScratch, syncDecalInstances, type DecalSyncScratch } from '@client/scene/decalLayout'

/**
 * RQ-70(탄흔)·RQ-71(피격 효과) 2/2 — **렌더 배선**(ADR-0016 결정 4, 단위
 * 테스트 면제 — 대신 스크린샷). 법선 정렬 산술·컬렉션→인스턴스 카운트
 * 환산은 이 파일의 책임이 아니다 — `@client/scene/decalLayout`(순수 함수,
 * `tests/unit/rq-70-71-decal-layout.test.ts`가 값으로 단언)에 이미 있다.
 * 이 파일은 그 함수를 `useFrame` 안에서 부르고, `THREE.InstancedMesh` 생성·
 * 지오메트리/머티리얼/토큰 배선만 담당한다.
 *
 * **`InstancedMesh`로 그린다** — 명중마다 `new THREE.Mesh(...)`를 만들지
 * 않는다(`harness/workflow/fe.md` "효과 처리" — 명중 빈도에 비례해
 * 드로우콜·GC 압박이 늘어나는 것을 막는다).
 *
 * `harness/workflow/fe.md` 레이어 규칙 — R3F 컴포넌트 안에서 `useStore()`
 * 구독 금지(store가 서버 패치마다 갱신돼 매 프레임 React 리렌더가 걸린다).
 * 대신 `useFrame` 안에서 `store.getState()`로 직접 읽는다(`PlayerMeshes.tsx`
 * 위치 갱신 경로와 동일한 패턴) — React 리렌더 경로를 타지 않는다.
 *
 * **참가·퇴장 배선이 없다** — `PlayerMeshes`와 달리 이 컴포넌트는 인스턴스
 * 수가 바뀔 때마다 개별 `THREE.Mesh`를 만들거나 지우지 않는다.
 * `InstancedMesh` 2개(탄흔·피격 효과)를 마운트 시 한 번만 만들고, 이후는
 * `syncDecalInstances`가 매 프레임 그 버퍼의 내용과 그리기 범위(`count`)만
 * 갱신한다.
 */

/**
 * 피격 효과(RQ-71) **GPU 버퍼 용량** — ⚠️ 제거 규칙이 아니다(ADR-0016 결정
 * 2 — 피격 효과에 개수 상한을 두면 위반이다. 탄흔과 달리 TTL
 * (`EFFECTS_TUNING.HIT_EFFECT_DURATION_MS`)만이 제거 규칙이고, 그 판정은
 * `@client/effects/hitFeedback`의 `advanceHitFeedback`이 이미 한다).
 * `InstancedMesh`는 생성 시 유한한 인스턴스 버퍼를 할당해야 하므로, 그
 * 크기를 여기서 잡을 뿐이다 — **용량과 제거 규칙은 다른 축**이다
 * (`harness/workflow/fe.md` "효과 처리").
 *
 * 최악의 경우 추정(리터럴 발명이 아니라 정본 상수에서 유도, ADR-0010):
 * 정원(`CAPACITY.PLAYERS`) 전원이 최대 연사(`WEAPON.FIRE_INTERVAL_MS`)로
 * 쉬지 않고 서로를 맞힌다고 가정하면, TTL 창
 * (`EFFECTS_TUNING.HIT_EFFECT_DURATION_MS`) 동안 한 플레이어가 동시에 살아
 * 있게 할 수 있는 피격 효과는 최대 `ceil(TTL / FIRE_INTERVAL_MS)`개 —
 * 전원이면 그 값에 정원을 곱한 수다(10명 × 150ms 간격 × 400ms TTL 기준
 * 현재 값으로는 3×10=30). 그 위에 4배의 여유를 둔 값을 버퍼 용량으로
 * 잡는다. 이 숫자를 넘는 일은 거의 없지만, 넘더라도 아래 `useFrame`이
 * `state.hitEffects`를 이 용량으로 방어적으로 잘라(가장 최근 것 우선)
 * `syncDecalInstances`에 넘긴다 — 그 자름도 **버퍼 보호이지 제거 규칙이
 * 아니다**(오래된 것이 화면에서 먼저 빠지는 것이지, TTL보다 먼저
 * "사라지는" 것은 아니다 — 다음 프레임에 컬렉션이 용량 이하로 줄면 다시
 * 보인다).
 */
const WORST_CASE_CONCURRENT_HIT_EFFECTS =
  CAPACITY.PLAYERS * Math.ceil(EFFECTS_TUNING.HIT_EFFECT_DURATION_MS / WEAPON.FIRE_INTERVAL_MS)
const HIT_EFFECT_INSTANCE_CAP = WORST_CASE_CONCURRENT_HIT_EFFECTS * 4

interface HitDecalsProps {
  store: StoreApi<GameStoreState>
}

export function HitDecals({ store }: HitDecalsProps) {
  const bulletHoleMeshRef = useRef<THREE.InstancedMesh>(null)
  const hitEffectMeshRef = useRef<THREE.InstancedMesh>(null)
  // ADR-0001 프레임 예산 — 매 프레임 재사용하는 스크래치 버퍼 하나
  // (`PlayerMeshes.tsx`의 `GAIT_SWING_SCRATCH`/`interpolatedRef`와 동일한
  // 정신). `createDecalScratch()`가 만드는 `THREE.Matrix4`/`Quaternion`/
  // `Vector3`는 이 컴포넌트 생애주기 내내 재사용되고 `useFrame` 안에서
  // 새로 만들어지지 않는다.
  const scratchRef = useRef<DecalSyncScratch>(createDecalScratch())

  useFrame(() => {
    const bulletHoleMesh = bulletHoleMeshRef.current
    const hitEffectMesh = hitEffectMeshRef.current
    if (!bulletHoleMesh || !hitEffectMesh) return

    const state = store.getState()
    // 방어적 버퍼 보호(위 HIT_EFFECT_INSTANCE_CAP docblock) — 정상 경로에서는
    // 항상 length <= HIT_EFFECT_INSTANCE_CAP이라 이 분기를 타지 않는다(할당
    // 없음). 넘는 경우에만 최근 것 우선으로 슬라이스한다.
    const hitEffects =
      state.hitEffects.length > HIT_EFFECT_INSTANCE_CAP
        ? state.hitEffects.slice(state.hitEffects.length - HIT_EFFECT_INSTANCE_CAP)
        : state.hitEffects

    syncDecalInstances(
      hitEffects === state.hitEffects ? state : { bulletHoles: state.bulletHoles, hitEffects },
      { bulletHoles: bulletHoleMesh, hitEffects: hitEffectMesh },
      { offsetM: DECAL.offsetM, scratch: scratchRef.current },
    )
  })

  return (
    <group name="hit-decals">
      {/* RQ-70 탄흔 — 개수 상한(EFFECTS.BULLET_HOLE_CAP)이 유일한 제거
          규칙이고 여기 버퍼 용량과 정확히 같다(둘 다 64) — `syncDecalInstances`
          가 그 상한을 스스로도 방어한다(decalLayout.ts). frustumCulled를
          끄는 이유: 탄흔이 맵 전역에 흩어지므로 인스턴스 추가·제거마다
          바운딩 스피어를 다시 계산하지 않으면 화면 밖으로 잘못 컬링될 수
          있다 — 인스턴스 수(최대 64)가 적어 컬링 없이도 비용이 작다. */}
      <instancedMesh ref={bulletHoleMeshRef} args={[undefined, undefined, EFFECTS.BULLET_HOLE_CAP]} frustumCulled={false}>
        <circleGeometry args={[DECAL.bulletHoleRadiusM, 12]} />
        <meshStandardMaterial color={DECAL.bulletHoleColor} />
      </instancedMesh>
      {/* RQ-71 피격 효과 — TTL만으로 제거된다(개수 상한 없음, ADR-0016 결정
          2). 아래 용량(HIT_EFFECT_INSTANCE_CAP)은 그 제거 규칙과 무관한
          GPU 버퍼 크기일 뿐이다(이 파일 상단 docblock). */}
      <instancedMesh ref={hitEffectMeshRef} args={[undefined, undefined, HIT_EFFECT_INSTANCE_CAP]} frustumCulled={false}>
        <circleGeometry args={[DECAL.hitEffectRadiusM, 12]} />
        <meshStandardMaterial color={DECAL.hitEffectColor} />
      </instancedMesh>
    </group>
  )
}
