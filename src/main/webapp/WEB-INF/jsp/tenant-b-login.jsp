<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<!DOCTYPE html>
<html>
<head>
    <title>Harbor Community Bank - Operations</title>
    <link href="${pageContext.request.contextPath}/css.css" rel="stylesheet" type="text/css">
</head>
<body>
<div id="container">
    <div id="header"><div class="bank-logo">HARBOR COMMUNITY BANK</div></div>
    <div id="content-container">
        <div id="content"><center>
            <h1>Harbor Community Bank</h1>
            <h2>Operations Sign In</h2>
            <c:if test="${loginFailed}"><p style="color: red;"><b>Sign-in failed.</b></p></c:if>
            <form action="${pageContext.request.contextPath}/tenant-b/validatelogin" method="POST">
                <label for="operator-id"><b>Operator ID</b></label>
                <input id="operator-id" type="text" name="username" /><br/><br/>
                <label for="passcode"><b>Passcode</b></label>
                <input id="passcode" type="password" name="password" /><br/><br/>
                <input type="submit" value="Sign In" />
                <input type="reset" value="Reset" />
            </form>
        </center></div>
    </div>
</div>
</body>
</html>
