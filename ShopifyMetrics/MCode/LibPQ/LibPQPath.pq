let
    Source = Table.FromRows(Json.Document(Binary.Decompress(Binary.FromText("BcExDoAgDADAvzArJQwMvkFfQBgAidQEMKXEyOu9s1aIRWTmp28A5F95IecRRk8UW+VUWcZWgE7088aSappwQPFYYcdAnj7QSptVGRDO/Q==", BinaryEncoding.Base64), Compression.Deflate)), let _t = ((type nullable text) meta [Serialized.Text = true]) in type table [Local = _t, Web = _t])
in
    Source