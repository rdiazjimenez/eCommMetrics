// ExGraphQL_SalesBasic testing otro testing nuevo
// Example: paid orders via fnShopifyGraphQL (native GraphQL, not ShopifyQL).
// Uses ParamReportStartDate and ParamReportEndDate for the date range.
// Fetches first 50 paid orders in the inclusive date range. For larger ranges, add cursor pagination.
// Returns a typed table with one row per order.
let
    StartDate = Date.From(ParamReportStartDate),
    EndDate   = Date.From(ParamReportEndDate),
    ValidStartDate = if StartDate > EndDate
                     then error "ParamReportStartDate must be on or before ParamReportEndDate."
                     else StartDate,
    Since        = Date.ToText(ValidStartDate, "yyyy-MM-dd"),
    EndExclusive = Date.ToText(Date.AddDays(EndDate, 1), "yyyy-MM-dd"),
    FirstOrdersToFetch = 50,

    Search = "created_at:>=" & Since
          & " created_at:<" & EndExclusive
          & " financial_status:paid",

    Query = "{ orders(first: " & Number.ToText(FirstOrdersToFetch) & ", query: """ & Search & """) { "
          & "edges { node { "
          & "id name createdAt "
          & "totalPriceSet { shopMoney { amount currencyCode } } "
          & "subtotalPriceSet { shopMoney { amount } } "
          & "totalDiscountsSet { shopMoney { amount } } "
          & "} } } }",

    Response = fnShopifyGraphQL(ParamShopName, ParamApiVersion, ParamAccessToken, Query),

    CheckedResponse = if Record.HasFields(Response, "errors")
                      then error "GraphQL errors: " & Text.Combine(List.Transform(Response[errors], each
                if Value.Is(_, type record) and Record.HasFields(_, "message")
                then Text.From(_[message])
                else Text.From(_)
            ), "; ")
                      else Response,

    Data = Record.FieldOrDefault(CheckedResponse, "data", null),

    Edges = if Value.Is(Data, type record)
               and Record.HasFields(Data, "orders")
               and Data[orders] <> null
            then Record.FieldOrDefault(Data[orders], "edges", {})
            else error "GraphQL response missing data.orders.edges.",

    EmptyTable = #table(
        type table [
            id = text,
            name = text,
            createdAt = datetimezone,
            total_price = number,
            currency = text,
            subtotal_price = number,
            total_discounts = number
        ],
        {}
    ),

    Typed = if List.IsEmpty(Edges)
            then EmptyTable
            else
                let
                    Nodes           = List.Transform(Edges, each Record.FieldOrDefault(_, "node", [])),
                    NodeTable       = Table.FromRecords(Nodes),
                    AddTotalPrice   = Table.AddColumn(NodeTable, "total_price", each [totalPriceSet][shopMoney][amount], type text),
                    AddCurrency     = Table.AddColumn(AddTotalPrice, "currency", each [totalPriceSet][shopMoney][currencyCode], type text),
                    AddSubtotal     = Table.AddColumn(AddCurrency, "subtotal_price", each [subtotalPriceSet][shopMoney][amount], type text),
                    AddDiscounts    = Table.AddColumn(AddSubtotal, "total_discounts", each [totalDiscountsSet][shopMoney][amount], type text),
                    SelectedColumns = Table.SelectColumns(AddDiscounts, {"id", "name", "createdAt", "total_price", "currency", "subtotal_price", "total_discounts"}),
                    ParsedNumbers   = Table.TransformColumns(SelectedColumns, {
                                          {"total_price", each try Number.FromText(Text.From(_), "en-US") otherwise null, type number},
                                          {"subtotal_price", each try Number.FromText(Text.From(_), "en-US") otherwise null, type number},
                                          {"total_discounts", each try Number.FromText(Text.From(_), "en-US") otherwise null, type number}
                                      }),
                    TypedColumns    = Table.TransformColumnTypes(ParsedNumbers, {
                                          {"id", type text},
                                          {"name", type text},
                                          {"createdAt", type datetimezone},
                                          {"currency", type text}
                                      })
                in
                    TypedColumns
in
    Typed