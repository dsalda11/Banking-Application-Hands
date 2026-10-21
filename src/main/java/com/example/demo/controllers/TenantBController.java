package com.example.demo.controllers;

import java.util.List;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpSession;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;

import com.example.demo.model.User;
import com.example.demo.service.CheckProfile;
import com.example.demo.service.LoginService;
import com.example.demo.service.Mailservice;

/**
 * A second configuration of the same legacy banking product. It deliberately reuses the same
 * authentication, customer, session, and database services while presenting variant routes and
 * JSP structure.
 */
@Controller
@RequestMapping("/tenant-b")
public class TenantBController {

	@Autowired
	private LoginService loginService;

	@Autowired
	private Mailservice mailService;

	@Autowired
	private CheckProfile checkProfile;

	@GetMapping("/login")
	public String login() {
		return "tenant-b-login";
	}

	@PostMapping("/validatelogin")
	public String validateLogin(@RequestParam String username, @RequestParam String password,
			ModelMap model, HttpServletRequest request) {
		String role = loginService.getRole(username, password);
		if (role == null || (!"admin".equals(role) && !"emp".equals(role))) {
			model.put("loginFailed", true);
			return "tenant-b-login";
		}
		HttpSession oldSession = request.getSession(false);
		if (oldSession != null) {
			oldSession.invalidate();
		}
		HttpSession session = request.getSession(true);
		session.setAttribute("username", username);
		session.setAttribute("role", role);
		mailService.sendEmail(username);
		return "redirect:/tenant-b/operations";
	}

	@GetMapping("/operations")
	public String operations(ModelMap model, HttpSession session) {
		model.put("username", session.getAttribute("username"));
		return "tenant-b-operations";
	}

	@GetMapping("/clients")
	public String clients(@RequestParam(required = false) String username, ModelMap model,
			HttpSession session) {
		List<User> customers = checkProfile.getCustomers(username);
		model.put("clients", customers);
		model.put("username", session.getAttribute("username"));
		model.put("searchUsername", username == null ? "" : username);
		model.put("notFound", username != null && !username.trim().isEmpty() && customers.isEmpty());
		return "tenant-b-clients";
	}

	@GetMapping("/client/account")
	public String account(@RequestParam String username, ModelMap model, HttpSession session) {
		List<User> customers = checkProfile.getDetails(username);
		model.put("clients", customers);
		model.put("username", session.getAttribute("username"));
		model.put("notFound", customers.isEmpty());
		return "tenant-b-account";
	}

	@GetMapping("/logout")
	public String logout(HttpServletRequest request) {
		HttpSession session = request.getSession(false);
		if (session != null) {
			session.invalidate();
		}
		return "redirect:/tenant-b/login";
	}
}
