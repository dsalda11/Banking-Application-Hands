<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<!DOCTYPE html>
<html>
<head>
    <title>Harbor Community Bank - Client Account</title>
    <link href="${pageContext.request.contextPath}/css.css" rel="stylesheet" type="text/css">
</head>
<body>
<div id="container">
    <jsp:include page="tenant-b-header.jsp"></jsp:include>
    <div id="content-container">
        <div id="content"><center>
            <h2>Client Account Summary</h2>
            <c:if test="${notFound}"><p style="color: red;"><b>No client matched the supplied login.</b></p></c:if>
            <c:forEach items="${clients}" var="client">
                <fieldset>
                    <legend>Core account record</legend>
                    <table cellpadding="8" border="1">
                        <tbody>
                            <tr><th>Client Name</th><td>${client.name}</td></tr>
                            <tr><th>Available Balance</th><td>${client.balance} USD</td></tr>
                            <tr><th>Account Number</th><td>${client.accno}</td></tr>
                            <tr><th>Client Login</th><td>${client.email}</td></tr>
                        </tbody>
                    </table>
                </fieldset>
            </c:forEach>
        </center></div>
    </div>
</div>
</body>
</html>
