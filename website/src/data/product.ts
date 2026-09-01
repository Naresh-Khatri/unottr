export const product = {
  name: "unottr",
  price: 79,
  currency: "USD",
  licenseVersion: "1.x",
  checkoutUrl: import.meta.env.PUBLIC_CHECKOUT_URL,
} as const;

export const formatPrice = (price: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(price);
