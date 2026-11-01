# Paper Radar

소비자행동(마케팅) 분야의 최신 논문과 지금 뜨는 논문을 매일 자동으로 모아 보여주는 개인 사이트예요.

- **데이터:** [OpenAlex](https://openalex.org) (무료, 키 필요 없음)
- **자동 업데이트:** GitHub Actions가 매일 오전 6시(KST)에 논문을 새로 모아 `site/data/`에 저장하고 사이트를 다시 배포해요.
- **호스팅:** GitHub Pages

## 처음 한 번만 설정

1. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿔요.
2. (선택) **Settings → Secrets and variables → Actions → Variables**에 `OPENALEX_MAILTO`로 이메일을 넣으면 OpenAlex가 더 안정적으로 응답해요.
3. **Actions → Update papers & deploy → Run workflow**를 한 번 눌러 첫 데이터를 만들어요.

## 주제·저널 바꾸기

`config.json`의 `topics`와 `journals`를 고치면 다음 업데이트부터 반영돼요. 사이트의 **+ 내 키워드 추가**로 넣은 키워드는 브라우저에 저장되고, 열 때마다 OpenAlex에서 바로 불러와요.

## "지금 뜨는 논문" 점수

최근 2년 논문을 대상으로 `나이 대비 인용 속도 × 10 + 최근 30일 인용 증가 × 2 + 올해 인용 × 0.5`로 정렬해요. 30일 증가는 매일 쌓이는 `site/data/history.json`으로 계산하므로 운영 한 달쯤 뒤부터 정확해져요.

## 로컬에서 보기

```bash
python scripts/fetch.py        # 데이터 받기
python -m http.server -d site  # http://localhost:8000
```
