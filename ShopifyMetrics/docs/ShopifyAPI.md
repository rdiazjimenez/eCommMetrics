You can think of GraphQL as Shopify’s general-purpose Admin API language, and ShopifyQL as a specialized analytics query language that you send through the GraphQL Admin API.

The most relevant docs to read alongside this answer are:

About the GraphQL Admin API https://shopify.dev/docs/apps/build/graphql
ShopifyQL with the GraphQL Admin API (shopifyqlQuery endpoint) https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api
ShopifyQL syntax reference https://shopify.dev/docs/apps/build/shopifyql/syntax
Below I’ll break down:

Conceptual differences: ShopifyQL vs GraphQL
How each is exposed in Shopify’s APIs
Example: “normal” Admin GraphQL query
Example: ShopifyQL query via shopifyqlQuery in the Admin GraphQL API
When to use which
1. Conceptual differences
GraphQL (Shopify Admin GraphQL API)
From Shopify’s About GraphQL: https://shopify.dev/docs/apps/build/graphql

What it is: A general query language and runtime for APIs.

What you use it for in Shopify: The GraphQL Admin API is the primary way to:

Read data: products, orders, customers, inventory, metafields, etc.
Write data: create/update products, fulfill orders, modify discounts, etc.
Shape of requests:

You define which fields you want on which objects.
You use queries to read and mutations to write.
Single endpoint for everything, e.g.:

POST /admin/api/2026-04/graphql.json

The schema includes hundreds of types and operations like products, product, orders, customerCreate, productUpdate, etc.

ShopifyQL
From ShopifyQL with the GraphQL Admin API: https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api

What it is: A domain-specific query language focused on analytics & reporting.
It’s not a replacement for GraphQL.
It’s for business questions like:
“What were my total sales and order count by day over the last week?”
“Top 10 products by revenue this month?”
Query style: SQL-like, with statements like:
text
Copy
1
2
3
4
5
  FROM sales
  SHOW total_sales, orders
  SINCE last_week
  GROUP BY day
  ORDER BY day DESC

What it can access: Shopify’s analytics data model (e.g. sales, products, customer data in an analytical/aggregated form).
How you call it: Via a single GraphQL field on the Admin API, shopifyqlQuery.
Output: A “table-like” structure (columns + rows) plus parse errors, all over GraphQL.
So, in practice:

GraphQL: General CRUD and admin operations on store data.
ShopifyQL: Analytics/reporting language, embedded inside a GraphQL query.
2. How each is exposed in the Shopify Admin API
Admin GraphQL API
Endpoint (HTTP):
http
Copy
1
2
3
4
5
  POST https://{shop}.myshopify.com/admin/api/2026-04/graphql.json
  X-Shopify-Access-Token: {access_token}
  Content-Type: application/json

  { "query": "...GraphQL operation here..." }
Auth: Private app / custom app access token, or OAuth access token.
Scopes: Access depends on what you read/write
Example: read_products to query products.
Docs:

About GraphQL and the Admin API https://shopify.dev/docs/apps/build/graphql
Admin API reference https://shopify.dev/docs/api/admin-graphql
ShopifyQL via the Admin GraphQL API
You don’t call a separate ShopifyQL HTTP endpoint. Instead, you:

Hit the same Admin GraphQL endpoint (/admin/api/{version}/graphql.json).
Run a normal GraphQL query that calls the shopifyqlQuery field.
Inside the query: argument, you put your ShopifyQL string.
From ShopifyQL with the GraphQL Admin API: https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api

GraphQL field:
Operation
Copy
1
  shopifyqlQuery(query: String!): ShopifyqlQueryResult!
Required scopes:
read_reports
read_customers if you query customer-related analytics.
And, if the query accesses protected customer data, your app must meet protected customer data https://shopify.dev/docs/apps/store/data-protection/protected-customer-data requirements.
3. Example: Pure Admin GraphQL query
This is a normal GraphQL Admin API operation to fetch a single product by ID.

Validated against the Admin API schema:

Operation
Copy
1
2
3
4
5
6
7
query SampleProduct {
  product(id: "gid://shopify/Product/10079785100") {
    id
    title
    handle
  }
}
This uses only GraphQL, no ShopifyQL.
You send it in the HTTP body:
json
Copy
1
2
3
  {
    "query": "query SampleProduct { product(id: \"gid://shopify/Product/10079785100\") { id title handle } }"
  }
Requires scope: read_products.
This is the style you’ll use for:

Managing products, customers, orders, inventory, discounts, etc.
Any CRUD action (create/update/delete) via mutations like productCreate, orderUpdate, etc.
4. Example: ShopifyQL query via the GraphQL Admin API
Here’s a GraphQL operation that calls shopifyqlQuery to run a ShopifyQL analytics query.

Validated against the Admin API schema (2026-04):

Operation
Copy
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
query SalesLastWeek {
  shopifyqlQuery(
    query: "FROM sales SHOW total_sales, orders SINCE last_week GROUP BY day ORDER BY day DESC"
  ) {
    tableData {
      columns {
        name
        dataType
        displayName
      }
      rows
    }
    parseErrors
  }
}
What’s happening here?
The outer structure is GraphQL:

query SalesLastWeek { ... }
Selecting the field shopifyqlQuery { ... }
Picking subfields tableData { columns { ... } rows } and parseErrors
The inner string is ShopifyQL:

text
Copy
1
2
3
4
5
  FROM sales
  SHOW total_sales, orders
  SINCE last_week
  GROUP BY day
  ORDER BY day DESC
This is parsed and executed by Shopify’s analytics engine.

Shape of the response
The docs show a JSON shape similar to:

json
Copy
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
{
  "data": {
    "shopifyqlQuery": {
      "tableData": {
        "columns": [
          {
            "name": "day",
            "dataType": "DAY_TIMESTAMP",
            "displayName": "Day"
          },
          {
            "name": "total_sales",
            "dataType": "MONEY",
            "displayName": "Total sales"
          },
          {
            "name": "orders",
            "dataType": "NUMBER",
            "displayName": "Orders"
          }
        ],
        "rows": [
          { "day": "2024-01-15", "total_sales": "2547.83", "orders": "23" },
          { "day": "2024-01-14", "total_sales": "1892.45", "orders": "17" }
        ]
      },
      "parseErrors": []
    }
  }
}
tableData.columns: metadata about each column.
tableData.rows: each row is a key/value map where keys match the columns.name.
parseErrors: array of strings if ShopifyQL fails to parse/validate, empty if OK.
HTTP request to call it
Same Admin GraphQL endpoint; only the query body changes:

http
Copy
1
2
3
POST https://{shop}.myshopify.com/admin/api/2026-04/graphql.json
X-Shopify-Access-Token: {access_token}
Content-Type: application/json
json
Copy
1
2
3
{
  "query": "query SalesLastWeek { shopifyqlQuery(query: \"FROM sales SHOW total_sales, orders SINCE last_week GROUP BY day ORDER BY day DESC\") { tableData { columns { name dataType displayName } rows } parseErrors } }"
}
(For maintainability, most clients build this string using multiline support or GraphQL clients.)

5. When to use GraphQL vs ShopifyQL
Use GraphQL Admin API when:
You’re doing day-to-day app behavior:
Managing products, variants, inventory, metafields.
Creating orders, updating fulfillments, editing customers.
You need record-level data, not just aggregates:
Example: Fetching specific orders with line items and shipping info.
You’re integrating with other Shopify features:
Functions, discounts, subscriptions, etc.
Start with the guides at About GraphQL https://shopify.dev/docs/apps/build/graphql and the Admin API and the Admin GraphQL reference https://shopify.dev/docs/api/admin-graphql.

Use ShopifyQL (via shopifyqlQuery) when:
You’re building analytics, dashboards, BI-style reporting, or exports of aggregated data:
Sales by day/week/month.
Top products/customers over a period.
Performance of channels or discounts.
You want pre-aggregated metrics from Shopify’s analytics backend instead of:
Pulling thousands of orders via GraphQL and aggregating yourself.
Use:

ShopifyQL with the GraphQL Admin API for how to call shopifyqlQuery. https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api 
https://shopify.dev/docs/apps/build/shopifyql/syntax ShopifyQL syntax reference to compose the FROM ... SHOW ... WHERE ... style queries.
6. Summary
GraphQL:

General Admin API.
Used for both queries (read) and mutations (write).
Powers almost everything your app does with store data.
ShopifyQL:

Specialized analytics/reporting language.
Always executed through the Admin GraphQL API via the shopifyqlQuery field.
Returns table-shaped data for dashboards, exports, and reports.
If you tell me a concrete use case (e.g., “show me monthly sales by country for the last year” or “fetch products with low inventory along with their variants”), I can give you:

A GraphQL Admin API query for the operational data,
And/or a ShopifyQL query plus GraphQL wrapper if it’s an analytics-style question.
Sources
Apps > Build > GraphQL https://shopify.dev/docs/apps/build/graphql
About the GraphQL Admin API https://shopify.dev/docs/apps/build/shopifyql/graphql-admin-api
Apps > Build > ShopifyQL > Graphql Admin API https://shopify.dev/docs/apps/build/shopifyql/syntax
ShopifyQL with the GraphQL Admin API (shopifyqlQuery endpoint) https://shopify.dev/docs/api/admin-graphql
Apps > Build > ShopifyQL > Syntax https://shopify.dev/docs/apps/store/data-protection/protected-customer-data
ShopifyQL syntax reference
API: Admin GraphQL
Admin API reference
Apps > Store > Data Protection > Protected Customer Data
protected customer data