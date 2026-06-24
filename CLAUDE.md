# EdTech HUB — 프로젝트 가이드

## 프로젝트 개요
EdTech HUB 공식 웹사이트. 런던 기반 EdTech 생태계 플랫폼으로, 스타트업·투자자·교육자를 연결하는 동적 웹사이트.

정적 HTML 사이트(index.html)를 Django 기반 동적 사이트로 변환 중.

## 로컬 구조
```
/Users/sungsoo/Desktop/vscode/edtechhub/
├── index.html          # 원본 정적 사이트 (레퍼런스용)
├── styles.css
├── main.js
└── eventbrite-crm/     # 별도 프로젝트 (edtechhub와 무관)
```

## EC2 서버 (실제 Django 프로젝트)
- **SSH 접속**: `ssh dohe-server` (키: `~/dohe_key.pem`, IP: `18.169.223.104`)
- **프로젝트 경로**: `~/edtechhub/src/`
- **GitHub**: https://github.com/sungsooro-dot/edtechhub.git

### Django 프로젝트 구조 (EC2: ~/edtechhub/src/)
```
edtechhub/         # Django 설정 (urls.py, views.py, settings/)
accounts/          # 회원가입·로그인·비밀번호 찾기
profiles/          # 사용자 프로필
projects/          # 프로젝트 앱
emails/            # 이메일
sms/               # SMS
templates/
  home.html        # 메인 페이지 (Django 템플릿으로 변환된 정적 사이트)
  accounts/
  projects/
```

### DB
- PostgreSQL: `edtechhub` (localhost:5432, user: ubuntu)
- 설정: `settings/production.py`

## 현재 배포 상태
- **미배포** — Gunicorn 서비스/Apache vhost 설정 없음
- 같은 서버에서 실행 중인 다른 앱:
  - `edtechtogether.com` → Gunicorn:8003 (gotogether Django, Terry 소유)
  - IP:80 → Django:8001 (todo 앱)
  - pm2: `edtech-crm` (Next.js CRM, port 3000)

## 🔒 절대 변경 금지
- **로고**: `logo.png` (teal + black 다이아몬드 심볼) — 코드 어디서든 SVG나 다른 이미지로 교체 금지. 항상 `<img src="logo.png">` 사용.

## 작업 중인 내용
- [ ] 디자인 개편 (레이아웃 / 색상 / 구조 — 개별 진행)
- [ ] Gunicorn + Apache 배포 설정

## 관련 프로젝트
- `edtech-crm` (`/Users/sungsoo/Desktop/vscode/edtech-crm/`) — Eventbrite CRM 대시보드 (별도)
- `edtechhub/eventbrite-crm/` — 초기 CRM 프로토타입 (미사용)
