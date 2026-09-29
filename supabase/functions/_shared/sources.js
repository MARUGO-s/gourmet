// 対応サイトのレジストリ（表示名・色・管理画面URL）。
// すべてのサイトは外部エージェント（Grok Bot）が取り込む。アプリはここのURL・セレクタでログイン・取得しない。
// login / fields / reviewsSelector は旧実装の雛形で、エージェント側の参考情報（未検証）。
export const SOURCES = [
  {
    id: "tabelog",
    name: "食べログ",
    nameEn: "Tabelog",
    color: "#D97C0F",
    // 店舗管理画面の専用ログイン（価格.com IDログインとは別系統。
    // login_id は6～12桁の半角英数で、食べログ利用者アカウントのメールアドレスではない）
    loginUrl: "https://owner.tabelog.com/owner_account/login/",
    dashboardUrl: "https://owner.tabelog.com/", // ログイン後、店舗管理画面へ
    login: { username: "#login_id", password: "#password", submit: "button[type=submit]" },
    // 読み取りは scripts/tabelog/（エージェント側・保存HTMLは scripts/tabelog-html-to-json.mjs）
  },
  {
    id: "hotpepper",
    name: "ホットペッパーグルメ",
    nameEn: "Hot Pepper",
    color: "#E84A7F",
    loginUrl: "https://pro.mppg.jp/login/", // ホットペッパービジネスアクセス
    dashboardUrl: "https://pro.mppg.jp/", // TODO: 要調整
    login: { username: "#member_id", password: "#password", submit: ".btn-login" },
    fields: {
      rating: ".rating-num", // TODO: 要調整
      reviewCount: ".review-num",
      pv: ".pv-num",
      reservations: ".reservation-num",
    },
    reviewsSelector: ".review-list .review", // TODO: 要調整
  },
  {
    id: "google",
    name: "Google マップ",
    nameEn: "Google",
    color: "#3B7DE9",
    loginUrl: "https://accounts.google.com/",
    dashboardUrl: "https://business.google.com/", // ビジネスプロフィール
    login: { username: "#identifierId", password: "#password input", submit: "#identifierNext, #passwordNext" },
    fields: {
      rating: "[data-rating]", // TODO: 要調整
      reviewCount: "[data-review-count]",
      pv: "[data-views]",
      reservations: "[data-reservations]",
    },
    reviewsSelector: "[data-review-id]", // TODO: 要調整
  },
  {
    id: "toreta",
    name: "トレタ",
    nameEn: "Toreta",
    color: "#12A5C9",
    loginUrl: "https://account.toreta.in/login", // TODO: 要調整
    dashboardUrl: "https://account.toreta.in/", // TODO: 要調整
    login: { username: "#email", password: "#password", submit: ".login-btn" },
    fields: {
      rating: "[data-rating]", // TODO: 要調整
      reviewCount: "[data-review-count]",
      pv: "[data-pv]",
      reservations: "[data-reservations]",
    },
    reviewsSelector: "[data-review]", // TODO: 要調整
  },
  {
    id: "ikyu",
    name: "一休.comレストラン",
    nameEn: "Ikyu",
    color: "#8A7340",
    loginUrl: "https://restaurant.ikyu.com/rsOwner/login",
    dashboardUrl: "https://restaurant.ikyu.com/",
    login: { username: "#rstid", password: "#pswd", submit: "button.submit" },
    fields: {
      rating: ".rating", // TODO: 要調整
      reviewCount: ".review-count",
      pv: ".pv-count",
      reservations: ".reservation-count",
    },
    reviewsSelector: ".review-list .review-item", // TODO: 要調整
  },
  {
    id: "retty",
    name: "Retty",
    nameEn: "Retty",
    color: "#DD3C3C",
    loginUrl: "https://retty.me/login", // TODO: 要調整
    dashboardUrl: "https://retty.me/", // TODO: 要調整
    login: { username: "#email", password: "#password", submit: "button[type=submit]" },
    fields: {
      rating: "[data-rating]", // TODO: 要調整
      reviewCount: "[data-review-count]",
      pv: "[data-pv]",
      reservations: "[data-reservations]",
    },
    reviewsSelector: "[data-review-item]", // TODO: 要調整
  },
];

export function getSource(id) {
  return SOURCES.find((s) => s.id === id);
}

export const SOURCE_IDS = SOURCES.map((s) => s.id);
