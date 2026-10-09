// Fichier généré par generate.mjs à partir de retailers/koro/spec.json. Ne pas modifier ici.
export interface ScopeField { key: string; env: string; description: string; example: string; pattern?: string }
export const RETAILER: {
  id: string; slug: string; version: string; label: string; origin: string; entryUrl: string; loginUrl: string; signupUrl: string;
  platform: string; fulfillment: ReadonlyArray<"delivery" | "click_and_collect">; accountRequired: boolean;
  scopeFields: ReadonlyArray<ScopeField>;
} = {
  "id": "koro",
  "slug": "koro",
  "version": "0.1.0",
  "label": "KoRo",
  "origin": "https://www.koro.fr",
  "entryUrl": "https://www.koro.fr/",
  "loginUrl": "https://www.koro.fr/account/login",
  "signupUrl": "https://www.koro.fr/account/login",
  "platform": "shopware",
  "fulfillment": [
    "delivery"
  ],
  "accountRequired": false,
  "scopeFields": []
};
