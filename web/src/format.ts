// Integer paise -> localized rupee string, e.g. 2120000 -> "₹21,200.00".
export function rupees(paise: number): string {
  return (paise / 100).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
  });
}
