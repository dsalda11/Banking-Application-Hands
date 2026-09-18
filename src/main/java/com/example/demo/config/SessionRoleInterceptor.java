package com.example.demo.config;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

import org.springframework.web.servlet.HandlerInterceptor;

public class SessionRoleInterceptor implements HandlerInterceptor {

	@Override
	public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
			throws Exception {
		String path = request.getServletPath();
		if (path.equals("/index") || path.equals("/login") || path.equals("/validatelogin")
				|| path.startsWith("/css/") || path.startsWith("/images/") || path.startsWith("/fonts/")
				|| path.equals("/css.css") || path.equals("/loginstyles.css")) {
			return true;
		}
		HttpSession session = request.getSession(false);
		if (session == null || session.getAttribute("username") == null) {
			response.sendRedirect(request.getContextPath() + "/login");
			return false;
		}
		String role = (String) session.getAttribute("role");
		if (path.equals("/staff") || path.equals("/showcust") || path.equals("/showadmin")
				|| path.equals("/showemp") || path.equals("/addadmin") || path.equals("/addemp")
				|| path.equals("/addcust")) {
			if (!"admin".equals(role) && !"emp".equals(role)) {
				response.sendError(HttpServletResponse.SC_FORBIDDEN, "Staff access required");
				return false;
			}
		}
		return true;
	}
}
