---
name: money
description: Read and write the owner's Beancount ledger (the `money` aspect, /srv/life/money) - record spending, income, transfers, investment buys and sells and prices, import a bank CSV, check balances, and answer questions about money with bean-query. Use for anything about the owner's finances, accounts, budgets or investments.
---

# The ledger

The owner's money is a Beancount ledger: plain-text double-entry accounting, in the
life folder, so it is private, synced and in the keeper's git history. Fava shows it
at https://money.balaur.space (the aspect `money`, on the server). `$BALAUR_LEDGER` is
the main file.

```
/srv/life/money/
  main.beancount        options and the includes; Fava and bean-check open this one
  accounts.beancount    every `open` and `close`, and the commodities
  prices.beancount      `price` lines: the value of funds, shares and currencies
  2026.beancount        the year's transactions, in date order (one file per year)
  import/               bank and broker exports (CSV), as downloaded
  importers.py          the beangulp importers for those exports
```

A new year gets its file and an `include` line in `main.beancount`.

## The loop, every time

1. Read before you write: `bean-query "$BALAUR_LEDGER" "SELECT account, sum(position) WHERE account ~ 'Assets' GROUP BY account"`, or `grep` the year's file for the payee.
2. Append to the right file. Never reorder or reformat what is there.
3. `bean-check "$BALAUR_LEDGER"`: no output means it balances. Fix every error it
   names (file and line) before you answer.
4. Tell the owner what you wrote, the lines themselves, and the balance it changed.

An amount, a date or an account you are not sure of: ask. A missing account: ask
before you `open` one, and add it to `accounts.beancount` dated on or before its first
use. Never balance a transaction with `Equity:` or an account the owner did not name.

## The forms

Accounts are `Assets:`, `Liabilities:`, `Income:`, `Expenses:` and `Equity:`, then
`Country:Institution:Account` for real accounts and a category for the others. The
operating currency is RON; EUR and others are kept as they are, never converted by
hand.

```beancount
; Spending. The last posting may leave its amount out: Beancount fills it in.
2026-11-20 * "Mega Image" "groceries"
  Expenses:Food:Groceries        142.35 RON
  Assets:RO:BT:Current

; Income.
2026-11-10 * "Employer" "salary November"
  Assets:RO:BT:Current         12000.00 RON
  Income:Salary

; A transfer between two of the owner's accounts.
2026-11-11 * "Savings"
  Assets:RO:BT:Savings          2000.00 RON
  Assets:RO:BT:Current

; Money in another currency: the price after @ is what one unit cost.
2026-11-12 * "Revolut" "EUR for the trip"
  Assets:EU:Revolut               200.00 EUR @ 4.97 RON
  Assets:RO:BT:Current

; A card: spending raises what is owed.
2026-11-13 * "eMAG" "headphones"
  Expenses:Electronics           399.00 RON
  Liabilities:RO:BT:Card

; What the bank says on a day (in the morning, before that day's transactions).
; bean-check fails when the ledger disagrees: the best guard there is.
2026-11-21 balance Assets:RO:BT:Current   8458.65 RON
```

### Investments

Shares and fund units are a commodity of their own (declared in
`accounts.beancount`), held at cost in `{}` so gains are computed, not guessed.

```beancount
; A buy: 10 units at 105.20 EUR each, with the broker's fee.
2026-11-14 * "XTB" "buy VWCE"
  Assets:EU:XTB:VWCE               10 VWCE {105.20 EUR}
  Expenses:Fees:Broker               1.00 EUR
  Assets:EU:XTB:Cash

; A sell: `{}` takes the lots first in, first out (the account's booking method);
; the gain goes to Income.
2026-12-02 * "XTB" "sell VWCE"
  Assets:EU:XTB:VWCE               -4 VWCE {} @ 110.00 EUR
  Assets:EU:XTB:Cash              440.00 EUR
  Income:Investments:Gains

; A dividend paid out.
2026-12-15 * "XTB" "VWCE dividend"
  Assets:EU:XTB:Cash                 3.10 EUR
  Income:Investments:Dividends

; The value on a day, in prices.beancount: what Fava's market value uses.
2026-11-20 price VWCE  108.40 EUR
2026-11-20 price EUR     4.97 RON
```

The account opens with its booking method:
`2026-01-01 open Assets:EU:XTB:VWCE VWCE "FIFO"`.

Prices are not fetched by themselves. When the owner asks for the value of the
portfolio, ask for (or look up) the latest price, add the `price` lines, then query.

## Questions: bean-query

Answer from a query, never from your own arithmetic.

```sh
L=$BALAUR_LEDGER
# Every account's balance now
bean-query "$L" "SELECT account, sum(position) WHERE account ~ '^(Assets|Liabilities)' GROUP BY account ORDER BY account"
# Spending by category in a month
bean-query "$L" "SELECT account, sum(position) WHERE account ~ '^Expenses' AND year = 2026 AND month = 10 GROUP BY account ORDER BY sum(position) DESC"
# The transactions of one payee
bean-query "$L" "SELECT date, narration, position WHERE payee ~ 'Mega Image' AND account ~ '^Expenses'"
# The portfolio at cost and at market value (needs price lines)
bean-query "$L" "SELECT account, units(sum(position)), cost(sum(position)), value(sum(position)) WHERE account ~ 'XTB' GROUP BY account"
# Net worth in RON
bean-query "$L" "SELECT convert(sum(position), 'RON') WHERE account ~ '^(Assets|Liabilities)'"
```

`bean-query "$L" ".help"` lists the columns and the functions.

## A bank export (CSV)

1. The export lands in `import/` (the owner drops it there, or names the file).
2. `importers.py` holds one beangulp importer per bank. A new bank: read the CSV's
   header and a few lines, write a `beangulp.importers.csvbase.Importer` subclass for
   it, and add it to the list at the end of the file. Run it with `money-python`
   (the Python that has beancount, beangulp and beanquery):

   ```sh
   cd /srv/life/money
   money-python importers.py identify import/
   money-python importers.py extract -e 2026.beancount import/ > /tmp/new.beancount
   ```

   `-e` skips what the ledger already has.
3. Read the result and give each transaction its category (`Expenses:...`): the
   owner's earlier transactions with the same payee say which. Ask about the ones you
   cannot tell.
4. Append them to the year's file, `bean-check`, then add a `balance` line from the
   export's closing balance, and `bean-check` again.
5. Leave the CSV in `import/`: it is the source.

## The page

Fava (`fava.service`, socket-activated, user `fava`) reloads the ledger when a file
changes, so what you write shows on the next page load. `money-check.service` runs
`bean-check` every night and fails when the ledger does not balance; the owner is told
of a failed unit. `journalctl -u fava -u money-check` shows both.
