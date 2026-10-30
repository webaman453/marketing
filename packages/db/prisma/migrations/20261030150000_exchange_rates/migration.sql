-- Daily ECB reference rates, so workspace totals can convert each ad account's currency.
CREATE TABLE "exchange_rates" (
    "id" BIGSERIAL NOT NULL,
    "date" DATE NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_rates_date_base_quote_key" ON "exchange_rates"("date", "base", "quote");

CREATE INDEX "exchange_rates_base_quote_date_idx" ON "exchange_rates"("base", "quote", "date");
