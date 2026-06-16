// ExShopifyQL_SalesBasic
// Example: daily sales metrics via fnShopifyQL.
// Uses ParamReportStartDate and ParamReportEndDate for the date range.
// Returns a typed table with one row per day.
let
    StartDate = Date.From(ParamReportStartDate),
    EndDate   = Date.From(ParamReportEndDate),
    ValidStartDate = if StartDate > EndDate
                     then error "ParamReportStartDate must be on or before ParamReportEndDate."
                     else StartDate,
    Since     = Date.ToText(ValidStartDate, "yyyy-MM-dd"),
    Until     = Date.ToText(EndDate, "yyyy-MM-dd"),

    Query = "FROM sales "
          & "SHOW orders, gross_sales, discounts, net_sales, total_sales "
          & "GROUP BY day "
          & "SINCE " & Since & " "
          & "UNTIL " & Until,

    Result = fnShopifyQL(ParamShopName, ParamApiVersion, ParamAccessToken, Query),

    ParseErrors = Record.FieldOrDefault(Result, "parseErrors", {}),
    CheckedResult = if List.IsEmpty(ParseErrors)
                    then Result
                    else error "ShopifyQL parse errors: " & Text.Combine(List.Transform(ParseErrors, each
                if Value.Is(_, type record) and Record.HasFields(_, "message")
                then Text.From(_[message])
                else Text.From(_)
            ), "; "),

    ExpectedColumns = {"day", "orders", "gross_sales", "discounts", "net_sales", "total_sales"},
    ActualColumns   = List.Transform(Record.FieldOrDefault(CheckedResult, "columns", {}), each _[name]),
    MissingColumns  = List.Difference(ExpectedColumns, ActualColumns),
    Rows = if List.IsEmpty(MissingColumns)
           then Record.FieldOrDefault(CheckedResult, "rows", {})
           else error "Missing expected columns: " & Text.Combine(MissingColumns, ", ")
              & ". Got: " & Text.Combine(ActualColumns, ", "),

    EmptyTable = Table.TransformColumnTypes(#table(ExpectedColumns, {}), {
        {"day", type date},
        {"orders", Int64.Type},
        {"gross_sales", type number},
        {"discounts", type number},
        {"net_sales", type number},
        {"total_sales", type number}
    }),

    RawTable = if List.IsEmpty(Rows)
               then EmptyTable
               else if Value.Is(Rows{0}, type record)
               then Table.FromRecords(Rows, ExpectedColumns, MissingField.UseNull)
               else Table.FromRows(Rows, ActualColumns),

    Selected = Table.SelectColumns(RawTable, ExpectedColumns, MissingField.UseNull),

    Typed = if List.IsEmpty(Rows)
            then EmptyTable
            else
                Table.TransformColumns(Selected, {
                    {"day", each try Date.From(_) otherwise (try Date.FromText(Text.From(_), "en-US") otherwise null), type date},
                    {"orders", each try Int64.From(_) otherwise (try Int64.From(Number.FromText(Text.From(_), "en-US")) otherwise null), Int64.Type},
                    {"gross_sales", each try Number.From(_) otherwise (try Number.FromText(Text.From(_), "en-US") otherwise null), type number},
                    {"discounts", each try Number.From(_) otherwise (try Number.FromText(Text.From(_), "en-US") otherwise null), type number},
                    {"net_sales", each try Number.From(_) otherwise (try Number.FromText(Text.From(_), "en-US") otherwise null), type number},
                    {"total_sales", each try Number.From(_) otherwise (try Number.FromText(Text.From(_), "en-US") otherwise null), type number}
                })
in
    Typed