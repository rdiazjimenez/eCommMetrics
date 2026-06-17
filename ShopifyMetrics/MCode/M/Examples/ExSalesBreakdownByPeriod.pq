// ExSalesBreakdownByPeriod
// Example: sales breakdown via fnGetSalesBreakdownByPeriod.
// Change GroupByField to "week" or "month" to test other grains.
let
    Local = Excel.CurrentWorkbook(){[Name="ExSalesBreakdownByPeriod"]}[Content],
    ChangeTypeDate = Table.TransformColumnTypes(Source,{{"day", type date}}),
    FilterRowsRefresh = Table.SelectRows(ChangeTypeDate, each [day] <= Date.From(ParamReportRefreshDate)),
    GroupByField = "day",
    StartDate = Date.From(ParamReportStartDate),
    EndDate = Date.From(ParamReportEndDate),
    RefreshDate = Date.From(ParamReportRefreshDate),
    WeekStartDay = Number.From(ParamReportWeekStartDay),

    ValidStartDate = if StartDate > EndDate
                     then error "ParamReportStartDate must be on or before ParamReportEndDate."
                     else StartDate,

    Source = fnGetSalesBreakdownByPeriod(
        ParamShopName,
        ParamApiVersion,
        ParamAccessToken,
        ValidStartDate,
        EndDate,
        RefreshDate,
        WeekStartDay,
        GroupByField,
        "ExSalesBreakdownByPeriod"
    ),
    AppendedQuery = Table.Combine({FilterRowsRefresh, Source}),
    #"Sorted Rows" = Table.Sort(AppendedQuery,{{"day", Order.Ascending}})
in
    #"Sorted Rows"