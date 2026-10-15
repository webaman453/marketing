/** Common reporting timezones, ordered by likely use. */
export const TIMEZONES = [
  { id: "Asia/Kolkata", label: "India (IST, UTC+5:30)" },
  { id: "Asia/Dubai", label: "Dubai (GST, UTC+4)" },
  { id: "Asia/Singapore", label: "Singapore (SGT, UTC+8)" },
  { id: "Europe/London", label: "London (GMT/BST)" },
  { id: "Europe/Berlin", label: "Central Europe (CET/CEST)" },
  { id: "America/New_York", label: "US Eastern (ET)" },
  { id: "America/Chicago", label: "US Central (CT)" },
  { id: "America/Los_Angeles", label: "US Pacific (PT)" },
  { id: "Australia/Sydney", label: "Sydney (AET)" },
  { id: "UTC", label: "UTC" },
] as const;

export const CURRENCY_LABELS: Record<string, string> = {
  INR: "INR · Indian Rupee",
  USD: "USD · US Dollar",
  EUR: "EUR · Euro",
  GBP: "GBP · British Pound",
  AED: "AED · UAE Dirham",
  AUD: "AUD · Australian Dollar",
  CAD: "CAD · Canadian Dollar",
  SGD: "SGD · Singapore Dollar",
};
