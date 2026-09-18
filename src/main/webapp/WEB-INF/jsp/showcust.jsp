
<%@ taglib prefix="c" uri="http://java.sun.com/jsp/jstl/core"%>
<div id="container">
<link href="css.css" rel="stylesheet" type="text/css">
<c:choose>
    <c:when test="${role == 'admin'}"><jsp:include page="admin-header.jsp"></jsp:include></c:when>
    <c:otherwise><jsp:include page="emp-header.jsp"></jsp:include></c:otherwise>
</c:choose>

<div id="content-container">
<div id="content"><center>
<marquee><h2 style="color: red;"><i>--- Welcome ${username} ---</i></h2></marquee><br/><br/>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;

<form action="showcust" method="GET">
    <label for="username">Find customer by username:</label>
    <input id="username" type="text" name="username" value="${searchUsername}" />
    <input type="submit" value="Search" />
</form><br/>
<c:if test="${notFound}"><p style="color: red;"><b>Customer not found.</b></p></c:if>

<table cellpadding="10" border="1">
		<tr>
			<td>Name</td>
			<td>Email</td>
		    <td>Account No.</td>
		    <td>Balance</td>
		    <td>Action</td>
		    <td>Address</td>
		    <td>Contact No</td>
		</tr>
<c:forEach items="${allcust}" var="allcust">
	<tr>
		<td>${allcust.name}</td>
		<td>${allcust.email}</td>
	    <td>${allcust.accno}</td>
	    <td>${allcust.balance}</td>
	    <td><a href="getDetails?username=${allcust.email}">View Details</a></td>
	    <td>${allcust.address}</td>
	    <td>${allcust.mobno}</td>
     </tr>
</c:forEach>
</table>

</div>

<div id="aside">
<p>* Online banking is the practice of making bank transactions or paying bills via the Internet.
<br/><br/>* Banking online allows a customer to make deposits, withdrawals, transfers with the click of a mouse.
<br/><br/>* Online banking also eliminates paper waste, which is a plus not only for those who have to handle all the paper work, but also for the environment.
<br/><br/>* Security is always an issue with Internet transactions. Although information is encrypted , and the chances of an account being hacked are slim, it happen.
</p>
</div>
</div>
</div>
