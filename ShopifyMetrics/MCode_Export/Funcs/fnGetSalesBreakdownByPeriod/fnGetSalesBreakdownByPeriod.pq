let
    Source = (ParamShopName as text, ParamApiVersion as text, ParamAccessToken as text, ParamReportStartDate as date, ParamReportEndDate as date, ParamReportRefreshDate as date, ParamReportWeekStartDay as number, ParamGroupByField as any, ParamHistoricalTable as any) => let
        GroupByField = Text.From(ParamGroupByField),
        StartDate = Date.From(ParamReportStartDate),
        EndDate = Date.From(ParamReportEndDate),
        RefreshDate = Date.From(ParamReportRefreshDate),
        WeekStartDay = Number.From(ParamReportWeekStartDay),
        ShopName = Text.From(ParamShopName),
        ApiVersion = Text.From(ParamApiVersion),
        AccessToken = Text.From(ParamAccessToken),
        HistoricalTable = ParamHistoricalTable,
        SourceTable = "sales",
    
        GetSalesMetrics = () as list => {
            "orders",
            "quantity_ordered_per_order",
            "average_order_value",
            "quantity_returned",
            "gross_sales",
            "discounts",
            "sales_reversals",
            "net_sales",
            "shipping_charges",
            "return_fees",
            "taxes",
            "total_sales",
            "net_sales_without_cost_recorded",
            "net_sales_with_cost_recorded",
            "cost_of_goods_sold",
            "gross_profit",
            "gift_card_gross_sales",
            "net_items_sold",
            "gift_card_discounts",
            "gift_card_net_sales"
        },
    
        GetApiGroupBy = () as text =>
            if GroupByField = "week" then "day" else GroupByField,
    
        BuildShopifyQL = (Period as record) as text =>
            "FROM " & SourceTable & " "
            & "SHOW " & Text.Combine(GetSalesMetrics(), ", ") & " "
            & "GROUP BY " & GetApiGroupBy() & " "
            & "SINCE " & Date.ToText(Period[startDate], "yyyy-MM-dd") & " "
            & "UNTIL " & Date.ToText(Period[endDate], "yyyy-MM-dd"),
    
        FetchRows = (Query as text) as list =>
            let
                ShopifyQLResult = fnShopifyQL(ShopName, ApiVersion, AccessToken, Query),
                ParseErrors = Record.FieldOrDefault(ShopifyQLResult, "parseErrors", {})
            in
                if List.IsEmpty(ParseErrors) then
                    Record.FieldOrDefault(ShopifyQLResult, "rows", {})
                else
                    error "ShopifyQL parse errors: " & Text.Combine(List.Transform(ParseErrors, each
                        if Value.Is(_, type record) and Record.HasFields(_, "message")
                        then Text.From(_[message])
                        else Text.From(_)
                    ), "; "),
    
        EmptyOutputTable = () as table =>
            let
                PeriodColumn = if GroupByField = "week" then "week" else GroupByField,
                OutputColumns = List.Combine({{PeriodColumn}, GetSalesMetrics(), {"refresh_date_SalesBreakdown"}}),
                Empty = #table(OutputColumns, {}),
                TypePairs = List.Combine({
                    {{PeriodColumn, type date}},
                    List.Transform(GetSalesMetrics(), each {_, type number}),
                    {{"refresh_date_SalesBreakdown", type datetime}}
                })
            in
                Table.TransformColumnTypes(Empty, TypePairs),
    
        RowsToTable = (PreparedPeriods as table) as table =>
            let
                NonEmpty = Table.SelectRows(PreparedPeriods, each [Rows] <> null and not List.IsEmpty([Rows])),
                ExpandedLists = Table.ExpandListColumn(NonEmpty, "Rows"),
                ApiColumns = List.Combine({{GetApiGroupBy()}, GetSalesMetrics()}),
                NormalizedRecords = Table.TransformColumns(ExpandedLists, {
                    {"Rows", each Record.SelectFields(_, ApiColumns, MissingField.UseNull), type record}
                }),
                ExpandedRecords = Table.ExpandRecordColumn(NormalizedRecords, "Rows", ApiColumns)
            in
                ExpandedRecords,
    
        NormalizePeriodColumn = (InputTable as table) as table =>
            if GroupByField = "week" then
                InputTable
            else
                let
                    PeriodColumn = GroupByField,
                    Normalized = Table.TransformColumns(InputTable, {
                        {PeriodColumn, each
                            let
                                TextValue = Text.From(_),
                                DateText = if GroupByField = "month" and Text.Length(TextValue) <= 7 then TextValue & "-01" else TextValue
                            in
                                try Date.From(_) otherwise Date.FromText(DateText, "en-US"), type date}
                    })
                in
                    Normalized,
    
        TypeMetricColumns = (InputTable as table) as table =>
            Table.TransformColumns(InputTable, List.Transform(GetSalesMetrics(), (MetricName) =>
                {MetricName, each try Number.From(_) otherwise (try Number.FromText(Text.From(_), "en-US") otherwise null), type number}
            )),
    
        AggregateCustomWeeks = (InputTable as table) as table =>
            let
                TypedMetrics = TypeMetricColumns(InputTable),
                Grouped = Table.Group(TypedMetrics, {"startDate", "endDate"},
                    List.Transform(GetSalesMetrics(), (MetricName) =>
                        {MetricName, each List.Sum(List.RemoveNulls(Table.Column(_, MetricName))), type number}
                    )
                ),
                WithWeek = Table.AddColumn(Grouped, "week", each [startDate], type date),
                Selected = Table.SelectColumns(WithWeek, List.Combine({{"week"}, GetSalesMetrics()}))
            in
                Selected,
    
        FinalizeOutput = (InputTable as table) as table =>
            let
                PeriodColumn = if GroupByField = "week" then "week" else GroupByField,
                Typed = if GroupByField = "week" then
                    InputTable
                else
                    TypeMetricColumns(NormalizePeriodColumn(InputTable)),
                OutputColumns = List.Combine({{PeriodColumn}, GetSalesMetrics()}),
                Selected = Table.SelectColumns(Typed, OutputColumns, MissingField.UseNull),
                Sorted = Table.Sort(Selected, {{PeriodColumn, Order.Ascending}}),
                WithRefreshDate = Table.AddColumn(Sorted, "refresh_date_SalesBreakdown", each DateTime.LocalNow(), type datetime)
            in
                WithRefreshDate,
    
        Periods = fnGetDatesInPeriod(StartDate, EndDate, RefreshDate, WeekStartDay, GroupByField, HistoricalTable),
        WithQueries = Table.AddColumn(Periods, "CustomQuery", each BuildShopifyQL(_), type text),
        WithRows = Table.AddColumn(WithQueries, "Rows", each FetchRows([CustomQuery]), type list),
        Result = if Table.IsEmpty(Table.SelectRows(WithRows, each [Rows] <> null and not List.IsEmpty([Rows]))) then
            EmptyOutputTable()
        else
            let
                RawRows = RowsToTable(WithRows),
                Shaped = if GroupByField = "week" then AggregateCustomWeeks(RawRows) else RawRows
            in
                FinalizeOutput(Shaped)
    in
        Result
in
    Source