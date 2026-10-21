<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<!DOCTYPE html>
<html>
<head>
    <title>Harbor Community Bank - Client Directory</title>
    <link href="${pageContext.request.contextPath}/css.css" rel="stylesheet" type="text/css">
</head>
<body>
<div id="container">
    <jsp:include page="tenant-b-header.jsp"></jsp:include>
    <div id="content-container">
        <div id="content"><center>
            <h2>Client Directory</h2>
            <fieldset>
                <legend>Legacy client lookup</legend>
                <form action="${pageContext.request.contextPath}/tenant-b/clients" method="GET">
                    <label for="client-login">Search client login:</label>
                    <input id="client-login" type="text" name="username" value="${searchUsername}" />
                    <input type="submit" value="Find Client" />
                </form>
            </fieldset>
            <c:if test="${notFound}">
                <p style="color: red;"><b>No client matched the supplied login.</b></p>
            </c:if>
            <div class="legacy-table-frame">
                <table cellpadding="10" border="1">
                    <thead>
                        <tr>
                            <th>Client</th>
                            <th>Account Balance</th>
                            <th>Account Number</th>
                            <th>Login</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        <c:forEach items="${clients}" var="client">
                            <tr>
                                <td>${client.name}</td>
                                <td>${client.balance}</td>
                                <td>${client.accno}</td>
                                <td>${client.email}</td>
                                <td><a href="${pageContext.request.contextPath}/tenant-b/client/account?username=${client.email}">Open Account</a></td>
                            </tr>
                        </c:forEach>
                    </tbody>
                </table>
            </div>
        </center></div>
    </div>
</div>
</body>
</html>
