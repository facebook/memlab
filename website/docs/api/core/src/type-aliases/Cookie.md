# Type Alias: Cookie

> **Cookie** = `object`

Defined in: core/src/lib/Types.ts:236

A single cookie entry in a Cookies list.
The `name` and `value` field is mandatory.
It is better to also specify the `domain` field, otherwise MemLab
will try to infer `domain` automatically.
The other fields are optional.
For concrete use case, please check out cookies.

## Properties

### domain?

> `optional` **domain**: `string`

Defined in: core/src/lib/Types.ts:242

Optional: Defines the domain associated with the cookie

***

### expires?

> `optional` **expires**: [`Undefinable`](Undefinable.md)\<`number`\>

Defined in: core/src/lib/Types.ts:251

Optional: Indicates when the cookie will expire, in Unix time (seconds)

***

### httpOnly?

> `optional` **httpOnly**: [`Undefinable`](Undefinable.md)\<`boolean`\>

Defined in: core/src/lib/Types.ts:253

Optional: Flag to determine if the cookie is accessible only over HTTP

***

### name

> **name**: `string`

Defined in: core/src/lib/Types.ts:238

Mandatory: Represents the name of the cookie

***

### path?

> `optional` **path**: [`Undefinable`](Undefinable.md)\<`string`\>

Defined in: core/src/lib/Types.ts:249

Optional: Defines the path associated with the cookie

***

### sameSite?

> `optional` **sameSite**: [`Undefinable`](Undefinable.md)\<`"Strict"` \| `"Lax"`\>

Defined in: core/src/lib/Types.ts:265

Optional: Determines if a cookie is transmitted with cross-site requests,
offering a degree of defense against cross-site request forgery attacks.

***

### secure?

> `optional` **secure**: [`Undefinable`](Undefinable.md)\<`boolean`\>

Defined in: core/src/lib/Types.ts:260

Optional: Flag to indicate if the cookie transmission
requires a secure protocol (e.g., HTTPS).

***

### session?

> `optional` **session**: [`Undefinable`](Undefinable.md)\<`boolean`\>

Defined in: core/src/lib/Types.ts:255

Optional: Flag to check if the cookie is a session cookie

***

### url?

> `optional` **url**: [`Undefinable`](Undefinable.md)\<`string`\>

Defined in: core/src/lib/Types.ts:247

Optional: Specifies the request-URI linked with the cookie setup.
This can influence the cookie's default domain and path.

***

### value

> **value**: `string`

Defined in: core/src/lib/Types.ts:240

Mandatory: Represents the value assigned to the cookie
