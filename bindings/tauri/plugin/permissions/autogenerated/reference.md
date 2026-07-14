## Default Permission

Allows the webview to drive the native syncular client: the one command
surface (syncular_command), the query paths (syncular_query and the atomic
syncular_query_snapshot sidecar), and the auth-rotation path
(syncular_set_headers). Grant this to the window(s)
that host your syncular-backed UI.

#### This default permission set includes the following:

- `allow-syncular-command`
- `allow-syncular-query`
- `allow-syncular-query-snapshot`
- `allow-syncular-set-headers`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`syncular:allow-syncular-command`

</td>
<td>

Enables the syncular_command command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`syncular:deny-syncular-command`

</td>
<td>

Denies the syncular_command command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`syncular:allow-syncular-query`

</td>
<td>

Enables the syncular_query command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`syncular:deny-syncular-query`

</td>
<td>

Denies the syncular_query command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`syncular:allow-syncular-query-snapshot`

</td>
<td>

Enables the syncular_query_snapshot command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`syncular:deny-syncular-query-snapshot`

</td>
<td>

Denies the syncular_query_snapshot command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`syncular:allow-syncular-set-headers`

</td>
<td>

Enables the syncular_set_headers command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`syncular:deny-syncular-set-headers`

</td>
<td>

Denies the syncular_set_headers command without any pre-configured scope.

</td>
</tr>
</table>
