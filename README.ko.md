# redrob-eval

[English](README.md) · [한국어](README.ko.md)

[![CI](https://github.com/redrob-labs/redrob-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/redrob-labs/redrob-eval/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

오픈소스 **LLM 평가 워크벤치**(Next.js App Router, Apache 2.0): 파라메트릭 템플릿에서 검증 가능한 평가 프롬프트를 만들고, 어떤 소스의 모델이든 *당신의* 과제 위에서 직접 비교하고, 정답이 없는 과제는 블라인드 사람 선호로 순위를 정하고, 품질 하한(quality floor) 아래에서 설정을 진화시키고, 자체 호스팅 모델을 GPU에 올립니다.

제품은 네 모듈과 설정입니다: **Compare · Evolve · Deploy · Generate**. Compare가 정문이고, 프론티어 API·OpenRouter·직접 띄운 vLLM이 텍스트든 이미지든 같은 목록에 나란히 놓입니다. 오디오는 모달리티 하나만 더 붙이면 됩니다. Generate는 나머지 세 모듈이 돌릴 아이템을 만듭니다. 비용을 표시하는 곳에서는 항상 기준선 대비 **%**이며 절대 통화 금액은 쓰지 않습니다. 프로바이더 키는 서버 측에만 둡니다.

## 발견한 점

- 직접 쓴 라우팅 규칙(프롬프트 길이, 키워드)은 일부 GSM8K 슬라이스에서 이중 모델 라벨과 약 25%만 일치했습니다. 프로덕션 정책으로 쓰기엔 부족합니다. ([`docs/learnings.md`](docs/learnings.md) 참고; 이중 평가 코퍼스는 gitignore된 `eval/routing-runs/`에 둡니다.)
- 그 라벨로 학습한 라우터는 관심 라벨에서 우연 수준을 넘지 못해 제거했습니다. 라벨링 파이프라인은 남고, 라우터는 사라졌습니다.
- 토크나이저 fertility는 고fertility 언어에서 강한 예산 제약입니다. 들어갈 수 있는 데모 수가 줄어 `demos_requested`와 `demos_fitted`가 갈라지고, 실질 탐색 공간이 좁아집니다.

## 샘플 결과 (커밋됨)

API 키 없이 `yarn export:samples`로 오프라인 재생성합니다. 전체 파일은 [`exports/samples/`](exports/samples/)에 있습니다.

**기준선 vs 진화 결과 (발췌):**

```text
Dataset: in22-gen-hi-en · Optimizer: gepa · Quality floor: 0.5

Baseline  val quality 0.6000 · val tokens 200 · demos 3/2
Evolved   val quality 0.7000 · val tokens 120 · demos 3/3

Token Δ (val): -80
Quality Δ (val): +0.1000
Relative cost vs baseline: 62.5%
```

![Pareto: relative cost % vs val quality for baseline and evolved](exports/samples/pareto.svg)

포트는 **`3939`**로 고정입니다.

## 요구 사항

- **Node.js** 20+ (22에서 테스트)
- **Yarn** Classic 1.22 (Corepack의 `yarn`도 가능)
- [OpenRouter](https://openrouter.ai/) API 키(권장) 또는 지원하는 다른 프로바이더 키

## 빠른 시작

```bash
git clone https://github.com/redrob-labs/redrob-eval.git
cd redrob-eval
cp .env.example .env
# .env에서 OPENROUTER_API_KEY=... 설정
yarn install
yarn verify:phase1
yarn verify:gepa
yarn verify:phase3
yarn export:samples
yarn dev
```

[http://localhost:3939](http://localhost:3939)를 열면 Compare로 들어갑니다. 나머지 페이지는 `/evolve`, `/deploy`, `/generate`, `/settings`입니다. `.env`를 수정한 뒤에는 `yarn dev`를 다시 시작하세요.

워크벤치는 OS의 라이트/다크 설정을 따르고, 바뀌면 같이 바뀝니다. 하나를 고정하려면 타이틀바 오른쪽 아이콘이나 Settings의 Appearance 카드에서 고르면 되고, 선택은 브라우저에 저장되며 `.env`에는 안 들어갑니다. `yarn verify:theme`은 두 팔레트의 모든 색 대비를 출력하고, `yarn test`는 다크가 라이트보다 낮은 대비로 떨어지면 실패합니다.

깨끗한 체크아웃에는 그 외 준비가 필요 없습니다. 평가는 벤더링된 데이터셋으로 오프라인 동작하고, 프로바이더 API 호출만 밖으로 나갑니다. CI는 push마다 모든 `yarn verify:*`와 `yarn export:samples`, `yarn build`를 돌립니다.

## 무엇을 하나요

| 모듈 | 경로 | 목적 |
|------|------|------|
| **Compare** | `/` 또는 `/compare` | 어떤 소스의 모델이든 카탈로그 데이터셋이나 직접 넣은 프롬프트 위에서 텍스트·이미지로 실행하고, 측정된 품질·지연·TTFT·처리량으로 순위를 매기고, 정답이 없으면 블라인드 선호 토너먼트로 정리한 뒤 그 투표를 라우팅 정책으로 바꿉니다. 작업 **툴 라우팅**은 모든 모델에 같은 JSON contract를 주고, 선택한 언어에서 툴 6개·18개·50개짜리 시나리오를 평가합니다 (fertility 선택). |
| **Evolve** | `/evolve` | 품질 하한 아래 instruction / demos / model / `script_policy` / `frame_policy` GEPA 탐색; 카탈로그 데이터셋 또는 커스텀 goal+rubric(LLM 판정 또는 checklist QWK); 기준선 대비 진화 리포트 내보내기 |
| **Deploy** | `/deploy` | SSH로 GPU 호스트에 자체 호스팅 S+L 서빙 - 측정, 기동, 헬스, 벤치마크, 재접속 가능한 터미널 |
| **Generate** | `/generate` | 파라메트릭 과제 템플릿과 로케일을 보고, content-derived seed로 인스턴스를 샘플링하고, 교차 로케일 스터디를 검증된 결과 아티팩트로 돌립니다. 둘 다 내보내거나 프롬프트를 Compare로 바로 넘길 수 있습니다 |
| **Settings** | `/settings` | 프로바이더 키와 GPU 호스트 설정을 gitignore된 루트 `.env`에 기록; 라이트/다크/시스템 테마와 언어도 여기 |

일반적인 루프: **Generate**로 검증 가능한 프롬프트 셋을 만들거나 카탈로그 데이터셋을 고르고 → **Compare**로 모델을 고르고 → 품질 하한 아래 **Evolve** → 고른 모델을 **Deploy**, 그리고 서빙된 엔드포인트를 다시 프론티어와 비교. 툴 라우팅 SLM은 **Deploy**(설치 / 측정 / 서빙) → **Compare**에서 모달리티 툴 라우팅.

### Generate

**Generate**는 검증 가능한 평가 프롬프트와 그 검증기를 파라메트릭하게 만듭니다. 아이템은 파일의 한 행이 아니라 템플릿과 시드이고, 시드는 고르는 게 아니라 생성기 버전·템플릿 id·인스턴스 인덱스에서 *유도*됩니다. 정적 셋이 가질 수 없는 두 가지를 얻습니다. 아이템은 누군가 생성기를 돌리기 전까지 존재하지 않았으므로 사전학습에 새어 들어갈 수 없습니다. 그리고 제3자가 공개된 값에서 같은 시드를 다시 계산해 확인할 수 있으므로, `42` 같은 관례적 시드와 달리 체리피킹은 금지가 아니라 구조적으로 불가능합니다. 채점은 판정 모델이 아니라 결정적 검증기가 합니다.

페이지 아래에는 [Redrob Verifiable Task Spec v2](spec/verifiable-task-v2.md), Python 생성기, 두 언어에 네이티브로 구현된 검증기, 둘이 어긋나면 CI가 실패하는 교차 언어 적합성 스위트가 있습니다.

**Python은 선택 사항입니다.** `yarn install && yarn dev`는 그대로이며 인터프리터가 없는 머신에서도 동작합니다. CI에는 PATH에서 Python을 지운 채 빌드하는 잡이 있어 그 상태를 지킵니다. TypeScript 쪽은 생성된 셋을 읽고 감사하며 모든 declarative 검증기를 네이티브로 돌리고, Python에는 명시적 서브프로세스로만 다가가며 없으면 실패 대신 조치 가능한 메시지를 냅니다. `/generate`도 같습니다. CLI 없이도 디스크에서 읽은 템플릿 카탈로그는 보이고, 샘플링에는 인터프리터가 필요하다고 분명히 말합니다.

```bash
# 선택: 인스턴스 샘플링이나 스터디를 돌릴 때만 필요
python -m venv .venv-generate
.venv-generate/Scripts/python -m pip install -e packages/generate   # Windows
# .venv-generate/bin/pip install -e packages/generate               # macOS / Linux

# 워크벤치가 PATH가 아닌 venv CLI를 쓰게 (저장소 루트 .env)
# REDROB_GENERATE_CMD=/absolute/path/to/.venv-generate/.../redrob-generate

redrob-generate emit --template templates/math/linear-equation --count 20 --out /tmp/set
redrob-generate verify --set /tmp/set --outputs answers.jsonl --json
yarn test                                            # Generate 스펙 TypeScript 적합성 스위트
```

작업 예시는 [`packages/generate/README.md`](packages/generate/README.md), 스터디는 [`packages/generate/STUDY.md`](packages/generate/STUDY.md), 템플릿 배치는 [`templates/README.md`](templates/README.md)를 보세요. 템플릿 내용은 사실상 영어만입니다. `hi`, `hi-Latn`, `ko` 로케일 파일은 파이프라인을 끝까지 돌리려고 있지만 영어 프롬프트를 그대로 담고 `untranslated`로 표시됩니다. 실제 번역은 원어민 리뷰가 필요하고, 아직 한 번도 없었고, 게시 가능 아티팩트는 그 위에서 만들기를 거부합니다.

### Compare의 네 단계

1. **Setup** - 모달리티(텍스트, 이미지, 툴 라우팅)를 고르고, 모든 소스(curated, OpenRouter, 직접 프론티어, 자체 호스팅 vLLM)에서 모델을 고른 뒤, 카탈로그 데이터셋·이미지 프롬프트 스위트·직접 붙여넣거나 JSONL로 올린 프롬프트 중 하나를 선택합니다. 툴 라우팅은 SLM 레지스트리·served model id·스텁 픽스처를 씁니다.
2. **Run** - SSE로 실시간 스트리밍합니다. 품질 점수는 정답이 있는 과제에서만 매기고, 지연·TTFT·처리량은 항상 이번 실행에서 측정합니다. 공개 가격은 실시간이 아니므로 비용 열은 없습니다.
3. **Preference** - 프롬프트마다 싱글 엘리미네이션 브래킷 하나. 모델 이름을 가린 채 답 두 개를 보여주고, 이긴 쪽이 올라가고, 챔피언이 그 프롬프트를 가져갑니다. 2의 거듭제곱이 아닌 참가 수는 부전승으로 채우고, 해당 프롬프트에서 에러가 난 모델은 부전패합니다. 이미지에서는 "판정 모델에게 맡기기"로 한 매치를 비전 모델에 넘기고 나머지는 직접 투표할 수 있습니다. 투표는 `eval/tournaments/{runId}/votes.jsonl`에 append됩니다.
4. **Optimize route** - 빠른 모델과 폴백을 지정합니다. 빠른 모델이 이기거나 비긴 프롬프트는 `small` 라벨, 나머지는 에스컬레이션. 지표 기반 수집기가 채우던 것과 같은 `RoutingExample` 코퍼스로 들어가므로 `/api/routing/export`와 학습 경로는 그대로입니다. 지도 신호만 지표에서 사람 선호로 바뀝니다.

브래킷과 라벨 로직 오프라인 검증: `yarn verify:tournament`.

Checklist / 비디오 스킬 채점(커스텀 goal `mode: "checklist"` 또는 `datasets/video-local/` 매니페스트)은 인간 채점자와의 일치(QWK)를 위해 판정 프롬프트 + `frame_policy`를 진화시키며, 과제 정확도가 목표가 아닙니다. 프레임은 메모리에서만 샘플링하고 비디오 바이트는 저장하지 않습니다.

공통 규칙:

- 프로바이더 키는 서버 `.env`만 (브라우저로 보내지 않음)
- 비용은 실행 기준선 대비 **상대 %** - 절대 통화 없음
- 메트릭은 숫자와 함께 `{ score, feedback }` 텍스트를 반환
- train/val은 최적화에 쓸 수 있고, **test는 한 번만 보고**되며 최적화에 쓰인 test를 다시 보고하려 하면 API가 거부합니다

## 모노레포 구조

| 경로 | 역할 |
|------|------|
| `apps/web` | Next.js UI + API 라우트 |
| `packages/harness` | 옵티마이저, 평가, 메트릭, 데이터셋, 프로바이더 (`@redrob/harness`) |
| `packages/tokenizers` | HF `AutoTokenizer` fertility (`@redrob/tokenizers`) |
| `datasets/` | 벤더링된 평가 서브셋(Apache 호환 라이선스만); 재배포 불가 checklist 매니페스트용 `video-local/` |
| `exports/samples/` | 커밋된, 재생성 가능한 Evolve 샘플 리포트 + Pareto SVG |
| `scripts/parity/` | 참고 GEPA와의 선택적 연구 비교 - 앱 실행에 **불필요** |
| `spec/` | Redrob Verifiable Task Spec v2 + 교차 언어 적합성 스위트 |
| `templates/` | Generate 템플릿, 패밀리별 디렉터리, 로케일 레이어 |
| `packages/generate` | 선택적 Python 생성기 `redrob-generate` - `yarn install && yarn dev` 경로에 **없음** |
| `train/` | 선택적 Python 라우터 학습 - `yarn install && yarn dev` 경로에 **없음** |

워크스페이스 패키지는 `"private": true`입니다(저장소 안에서만 사용; npm에 배포하지 않음).

## 출처 표기: GEPA

이 저장소는 논문([arXiv:2507.19457](https://arxiv.org/abs/2507.19457))을 바탕으로 [GEPA](https://github.com/gepa-ai/gepa)(Genetic-Pareto)를 TypeScript로 재구현합니다. 인용은 **agrawal2025gepa**. [`NOTICE`](NOTICE) 참고. 구현: `packages/harness/src/lib/optimizer/gepa/`이며, `src/gepa/`의 파일 단위 포트가 아닙니다.

**Evolve**에서는 카탈로그 데이터셋 또는 **Custom goal**(goal + rubric + input-only JSONL; LLM-as-judge)을 고릅니다. **Seed model**이 후보 프롬프트를 실행하고, **reflect model**이 실패 피드백으로 다시 쓰며, **judge**(커스텀 모드)가 루브릭으로 답을 채점합니다. 오프라인: `yarn verify:gepa`, `yarn verify:phase3`, `yarn verify:custom-goal`. 리포트 내보내기: `GET /api/optimize/runs/:id?export=md`.

## 문서

- [Contributing](CONTRIBUTING.md) - 설정, 그리고 브랜칭 모델: `main`은 프로덕션이고 릴리스만 받고, `develop`에서 분기하고 대상으로 삼습니다
- [Security](SECURITY.md)
- [Methodology](docs/methodology.md) - 라우팅 라벨, 피처, 내보내기
- [Preference](docs/preference.md) - 블라인드 브래킷, 순위·탈락 투표, 그리고 투표가 라우팅 라벨이 되는 방식
- [Multi-turn](docs/multi-turn.md) - 텍스트와 도구를 함께 다루는 대본형 대화 평가. 능력별로,
  그리고 대화가 깊어질수록 어떻게 되는지로 나눠서 봅니다
- [Learnings](docs/learnings.md) - 살아 있는 설계 로그
- [Decision records](docs/decisions/) - 설계가 그렇게 된 이유, 결정당 한 파일, 번호가 매겨지며 제자리에서 다시 쓰지 않습니다. 시작은
  [0001 Generate module foundation](docs/decisions/0001-generate-foundation.md), 이어서
  [0002 Unicode semantics](docs/decisions/0002-unicode-semantics.md),
  [0003 List-valued verifier field](docs/decisions/0003-list-valued-verifier-field.md),
  [0004 Branching model](docs/decisions/0004-branching-model.md),
  [0005 Study runner](docs/decisions/0005-study-runner.md).
- [Running a study](packages/generate/STUDY.md) - `redrob-generate study` 설정 형식, mock 프로바이더 작업 예시, 스텁 로케일을 게시할 수 없는 이유
- [Sample exports](exports/samples/README.md) - 재생성 리포트 + Pareto

## 환경 변수

| 변수 | 프로바이더 |
|------|------------|
| `OPENROUTER_API_KEY` | OpenRouter (권장) |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GOOGLE_API_KEY` | Google Gemini |
| `TOGETHER_API_KEY` | Together |
| `FIREWORKS_API_KEY` | Fireworks |
| `HF_TOKEN` | Hugging Face (데이터셋 fetcher, GPU 배포 시 모델 다운로드에 필요) |
| `VLLM_API_KEY` | 자체 배포 vLLM bearer (비어 있으면 `/deploy`가 자동 발급) |
| `VLLM_PORT` | Deploy가 공개할 포트 (기본: vLLM 관례인 `8000`) |
| `VLLM_BASE_URL` | 배포한 모델의 OpenAI 호환 엔드포인트 (기본: `http://localhost:8000/v1`, 원격 배포는 GPU 호스트로 지정) |
| `REDROB_GENERATE_CMD` | 선택: `redrob-generate` 실행 파일 절대 경로(예: `.venv-generate` 안). 비어 있으면 워크벤치가 `PATH`에서 찾습니다 |

키는 앱의 `/settings`에서 넣거나 환경변수로 주입합니다. GPU 배포 정보(`GPU_HOST`, `GPU_USER`, `GPU_SSH_KEY` 등)는 gitignore된 루트 `.env`에만 저장됩니다. [`deploy/README.md`](deploy/README.md) 참고. 호스트명·사용자명·키 경로·API 키를 저장소에 넣지 마세요.

### 자체 배포 상대 비용

토큰당 API 단가가 없으므로 측정된 throughput으로 상대 비용을 냅니다.

`relativeCostWeight(m) = 100 * (tok_per_sec_large / tok_per_sec_m)`

대형 단독 = 100 (토큰당 GPU 시간). 모델이 서빙 중일 때 `/deploy`에서 **Benchmark**를 돌리면 GPU 호스트에 `MEASURED_TOK_PER_SEC`가 기록되고, 앱은 그 숫자를 실제로 잰 모델에만 붙입니다. 한 번에 한 모델만 올리므로 후보를 비교하려면 차례로 배포해야 합니다. FP8과 bf16은 caveat 없이 같은 표에 올리지 않습니다.

Indic 대형 후보 A/B(Gemma 4 31B vs Qwen3.6 27B): **IN22-Gen** 슬라이스(`in22-gen-hi-en`).

`.env`는 **저장소 루트**에 둡니다. Next는 `apps/web/next.config.ts`로 로드합니다.

## API (개요)

**Optimize / Evolve**

- `POST /api/optimize` → `{ runId }`
- `GET /api/optimize/runs/:id/events` - SSE
- `GET /api/optimize/runs/:id` - meta + result + report
- `GET /api/optimize/runs/:id?export=md|json` - 다운로드 리포트

**Compare**

- `POST /api/compare/run` - SSE; `modality`(`text` | `image`)로 분기
- `POST /api/compare/tournament` - 실행 결과 답변으로 프롬프트별 브래킷 생성
- `GET /api/compare/tournament/:id` - meta + 브래킷 + 투표 + 순위
- `POST /api/compare/tournament/:id/vote` - 블라인드 투표 기록 후 진행
- `POST /api/compare/tournament/:id/judge` - 모달리티 판정 모델이 한 매치 결정
- `POST /api/compare/tournament/:id/route-policy` - 선호 라벨, save rate, 선택적 코퍼스 기록

**라우팅 수집**

- `POST /api/routing/collect` → `{ runId }`
- `GET /api/routing/runs/:id/events` - SSE
- `GET /api/routing/export?format=chat|flat` - 학습용 JSONL

**헤드리스**

- `POST /api/eval` - SSE 텍스트 eval, 라우터 베이스라인 옵션(`includeRouter`)
- `POST /api/preference/runs` - UI 없이 K×M 선호 생성
- `GET|POST /api/score` - 메트릭 픽스처 및 단건 채점

그 외: `/api/models`, `/api/datasets`, `/api/image/suites`, `/api/generate/*`, `/api/status`, `/api/probe`, …

## CLI

```bash
yarn verify:phase1   # 데이터셋, 분할, 상대 비용 헬퍼
yarn verify:gepa     # GEPA 단위 검사 (오프라인)
yarn verify:phase3   # script_policy, demo fit, report (오프라인)
yarn verify:custom-goal  # 커스텀 goal 파싱 + judge JSON (오프라인)
yarn verify:video    # frame_policy, QWK, rubric lint (오프라인)
yarn verify:tournament   # 선호 브래킷 + 선호 기반 라우팅 라벨 (오프라인)
yarn verify:selfhosted   # 셀프호스트 카탈로그 + 상대 비용, 통화 표기 금지 (오프라인)
yarn verify:preference-gen  # 선호 실행 계획 + 매트릭스 (오프라인)
yarn export:samples  # exports/samples 리포트 + Pareto SVG 작성
yarn test            # Generate 스펙 TypeScript 적합성 스위트 (오프라인)
yarn generate:spec-types  # spec/verifiable-task-v2.schema.json에서 TS 타입 재생성
yarn typecheck
yarn lint
yarn build
yarn probe
yarn datasets:fetch  # 벤더링 JSON 재생성 (런타임에 불필요)
yarn export:routing
```

### 선택: 라우터 학습 (Python 연구)

```bash
pip install -r train/requirements-mlp.txt
yarn train:mlp
yarn train:event-detect
```

[`train/README.md`](train/README.md) 참고.

## 팁

- 반복할 때는 **샘플 5-20개**부터
- exact-match 데이터셋 기본 임계값은 `0.99`
- Pareto 차트의 Oracle은 라벨링 규칙의 학습 목표 상한
- 높은 tokenizer fertility는 들어가는 데모를 줄입니다. Evolve 리포트에서 `demos_requested` vs `demos_fitted`를 확인하세요

## 작성자

Built by Janghoon Lee (이장훈)

## 라이선스

Apache-2.0. Copyright 2026 Redrob. [`LICENSE`](LICENSE)와 [`NOTICE`](NOTICE)를 보세요.
