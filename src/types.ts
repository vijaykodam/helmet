export interface HelmetProfile {
  baseUrl: string;
  cardNumber: string;
  pin: string;
  debug?: boolean;
}

export interface Loan {
  id: string;
  title: string;
  author: string | null;
  dueDate: string;
  checkoutDate: string | null;
  renewable: boolean;
  renewals: number | null;
  materialType: string | null;
  borrowingLocation: string | null;
  dueStatus: "overdue" | "due" | "ok";
  fetchedAt: Date;
}

export interface RenewalResult {
  id: string;
  success: boolean;
  newDueDate: string | null;
  message: string | null;
  /** Structured error code extracted from Finna's response, e.g. "RENEWED_TOO_SOON" */
  errorCode: string | null;
}

export interface Hold {
  id: string;
  title: string;
  author: string | null;
  pickupLocation: string | null;
  queuePosition: number | null;
  pickupDeadline: string | null;
  createdDate: string | null;
  shelfLocation: string | null;
  status: "in_transit" | "available_for_pickup" | "pending" | "unknown";
  cancelable: boolean;
  fetchedAt: Date;
}

export interface Fine {
  id: string;
  title: string | null;
  amount: number;
  currency: string;
  reason: string | null;
  createDate: string | null;
  fetchedAt: Date;
}

export interface SearchResult {
  id: string;
  title: string;
  author: string | null;
  year: string | null;
  formats: string[];
  languages: string[];
  buildings: string[];
  subjects: string[];
  isbn: string | null;
}

export interface SearchResponse {
  resultCount: number;
  records: SearchResult[];
  status: string;
}

export interface HoldActionResult {
  success: boolean;
  message: string | null;
}

export interface AccountSummary {
  loans: Loan[];
  holds: Hold[];
  fines: Fine[];
  totalFines: number;
  loansDueSoon: Loan[];
  loansOverdue: Loan[];
  holdsReady: Hold[];
  fetchedAt: Date;
}
